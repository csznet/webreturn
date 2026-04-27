interface CapturedRequest {
  id: string;
  timestamp: string;
  remote_addr: string;
  method: string;
  url: string;
  path: string;
  raw_query: string;
  query: Record<string, string[]>;
  headers: Record<string, string[]>;
  host: string;
  proto: string;
  body: string;
  body_size: number;
  truncated: boolean;
}

const MAX_BUFFER = 200;
const MAX_BODY = 1 << 20; // 1 MiB

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

function canonicalHeader(name: string): string {
  return name.replace(/(^|-)([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

export class CallbackSession {
  private state: DurableObjectState;
  private initialized = false;
  private expiresAt = 0;
  private host = '';
  private requests: CapturedRequest[] = [];
  private writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();

  constructor(state: DurableObjectState) {
    this.state = state;
    state.blockConcurrencyWhile(async () => {
      this.initialized = (await state.storage.get<boolean>('initialized')) ?? false;
      this.expiresAt = (await state.storage.get<number>('expiresAt')) ?? 0;
      this.host = (await state.storage.get<string>('host')) ?? '';
      this.requests = (await state.storage.get<CapturedRequest[]>('requests')) ?? [];
      // 加载时如果已过期,顺便清理
      if (this.initialized && Date.now() > this.expiresAt) {
        await this.purge();
      }
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/init') {
      return this.handleInit(url);
    }

    if (this.initialized && Date.now() > this.expiresAt) {
      await this.purge();
    }
    if (!this.initialized) {
      return new Response('not found', { status: 404 });
    }

    if (path === '/meta') {
      return Response.json({ expiresAt: this.expiresAt, host: this.host });
    }
    if (path === '/snapshot') {
      return Response.json(this.requests);
    }
    if (path === '/events') {
      return this.handleSSE();
    }
    if (path.startsWith('/capture')) {
      return this.handleCapture(req, path.slice('/capture'.length) || '/');
    }
    return new Response('not found', { status: 404 });
  }

  async alarm() {
    await this.purge();
  }

  private async handleInit(url: URL): Promise<Response> {
    if (this.initialized && Date.now() < this.expiresAt) {
      return new Response('collision', { status: 409 });
    }
    const ttl = parseInt(url.searchParams.get('ttl') || '0', 10);
    const host = url.searchParams.get('host') || '';
    if (ttl <= 0) return new Response('bad ttl', { status: 400 });

    this.initialized = true;
    this.expiresAt = Date.now() + ttl;
    this.host = host;
    this.requests = [];
    await this.state.storage.put({
      initialized: true,
      expiresAt: this.expiresAt,
      host,
      requests: [] as CapturedRequest[],
    });
    await this.state.storage.setAlarm(this.expiresAt);
    return new Response('ok');
  }

  private async handleCapture(req: Request, userPath: string): Promise<Response> {
    const url = new URL(req.url);

    let body = '';
    let bodySize = 0;
    let truncated = false;
    if (req.body) {
      const buf = await req.arrayBuffer();
      bodySize = buf.byteLength;
      const slice = bodySize > MAX_BODY ? buf.slice(0, MAX_BODY) : buf;
      truncated = bodySize > MAX_BODY;
      try {
        body = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(slice);
      } catch {
        body = '';
      }
    }

    const headers: Record<string, string[]> = {};
    for (const [k, v] of req.headers.entries()) {
      // 跳过 Worker 内部转发头
      if (k === 'x-webreturn-client-ip' || k === 'x-webreturn-host') continue;
      const cap = canonicalHeader(k);
      (headers[cap] ||= []).push(v);
    }

    const query: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams.entries()) {
      (query[k] ||= []).push(v);
    }

    const cr: CapturedRequest = {
      id: randomId(),
      timestamp: new Date().toISOString(),
      remote_addr: req.headers.get('x-webreturn-client-ip') || '',
      method: req.method,
      url: userPath + (url.search || ''),
      path: userPath,
      raw_query: url.search.slice(1),
      query,
      headers,
      host: req.headers.get('x-webreturn-host') || req.headers.get('host') || '',
      proto: 'HTTP/1.1',
      body,
      body_size: bodySize,
      truncated,
    };

    this.requests.push(cr);
    if (this.requests.length > MAX_BUFFER) {
      this.requests = this.requests.slice(-MAX_BUFFER);
    }
    await this.state.storage.put('requests', this.requests);

    const event = `event: request\ndata: ${JSON.stringify(cr)}\n\n`;
    const data = new TextEncoder().encode(event);
    const dead: WritableStreamDefaultWriter<Uint8Array>[] = [];
    for (const w of this.writers) {
      try {
        await w.write(data);
      } catch {
        dead.push(w);
      }
    }
    for (const w of dead) this.writers.delete(w);

    return Response.json({ received: true, request_id: cr.id, captured_at: cr.timestamp });
  }

  private handleSSE(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.writers.add(writer);

    const encoder = new TextEncoder();
    (async () => {
      try {
        for (const cr of this.requests) {
          await writer.write(encoder.encode(`event: request\ndata: ${JSON.stringify(cr)}\n\n`));
        }
      } catch {
        this.writers.delete(writer);
      }
    })();

    const keep = setInterval(() => {
      writer.write(encoder.encode(`: keepalive\n\n`)).catch(() => {
        clearInterval(keep);
        this.writers.delete(writer);
        writer.close().catch(() => {});
      });
    }, 15000);

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
      },
    });
  }

  private async purge() {
    const data = new TextEncoder().encode(`event: expired\ndata: {"reason":"会话已过期"}\n\n`);
    for (const w of this.writers) {
      try { await w.write(data); await w.close(); } catch {}
    }
    this.writers.clear();
    this.initialized = false;
    this.expiresAt = 0;
    this.host = '';
    this.requests = [];
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm().catch(() => {});
  }
}
