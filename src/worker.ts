import HOME_HTML from './home.html';
import VIEWER_HTML from './viewer.html';

export interface Env {
  SESSION: DurableObjectNamespace;
  DEFAULT_TTL?: string;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

const NUM = '0123456789';
const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyz';

const TOKEN_ATTEMPTS: Array<[string, number, number]> = [
  [NUM, 4, 16],
  [ALNUM, 4, 8],
  [ALNUM, 5, 8],
  [ALNUM, 6, 8],
];

// 保留路径 — 不能被当作 token
const RESERVED_FIRST_SEGMENT = new Set(['', 'api', 'favicon.ico', 'robots.txt']);

function parseTTL(s: string | undefined | null, fallback: number): number {
  if (!s) return fallback;
  const m = String(s).trim().match(/^(\d+)\s*([smhd])?$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 's').toLowerCase();
  const mult =
    unit === 's' ? 1000 :
    unit === 'm' ? 60_000 :
    unit === 'h' ? 3_600_000 :
                   86_400_000;
  return Math.max(1000, n * mult);
}

function randomToken(charset: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (let i = 0; i < length; i++) out += charset[bytes[i] % charset.length];
  return out;
}

function isValidToken(s: string): boolean {
  return /^[0-9a-z]{1,16}$/.test(s);
}

async function allocateToken(env: Env, ttlMs: number, host: string): Promise<string> {
  for (const [charset, len, tries] of TOKEN_ATTEMPTS) {
    for (let i = 0; i < tries; i++) {
      const token = randomToken(charset, len);
      const stub = env.SESSION.get(env.SESSION.idFromName(token));
      const res = await stub.fetch(
        `https://do/init?ttl=${ttlMs}&host=${encodeURIComponent(host)}`,
        { method: 'POST' },
      );
      if (res.status === 200) return token;
      // 409 = collision; try again
    }
  }
  throw new Error('token 空间已满');
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function plain(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function renderViewer(token: string, captureURL: string, expiresMs: number, hostPort: string): string {
  return VIEWER_HTML
    .replaceAll('__TOKEN__', JSON.stringify(token))
    .replaceAll('__URL__', JSON.stringify(captureURL))
    .replaceAll('__EXPIRES_MS__', String(expiresMs))
    .replaceAll('__HOST_PORT__', hostPort
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;'));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // 首页
    if (path === '/' && method === 'GET') {
      return htmlResponse(HOME_HTML);
    }

    if (path === '/favicon.ico' || path === '/robots.txt') {
      return new Response(null, { status: 204 });
    }

    // 创建会话
    if (path === '/api/sessions' && method === 'POST') {
      const ct = req.headers.get('content-type') || '';
      let ttlRaw: string | null = null;
      if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
        const form = await req.formData();
        ttlRaw = form.get('ttl') as string | null;
      } else {
        ttlRaw = url.searchParams.get('ttl');
      }
      const ttlMs = parseTTL(ttlRaw, parseTTL(env.DEFAULT_TTL, DEFAULT_TTL_MS));
      try {
        const token = await allocateToken(env, ttlMs, url.host);
        return new Response(null, { status: 303, headers: { Location: `/${token}` } });
      } catch (e) {
        return plain(String((e as Error).message), 503);
      }
    }

    // SSE / 快照
    if (path.startsWith('/api/sessions/')) {
      const rest = path.slice('/api/sessions/'.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) return plain('not found', 404);
      const token = rest.slice(0, slash);
      const sub = rest.slice(slash + 1);
      if (!isValidToken(token)) return plain('not found', 404);
      const stub = env.SESSION.get(env.SESSION.idFromName(token));
      if (sub === 'events') return stub.fetch('https://do/events');
      if (sub === 'requests') return stub.fetch('https://do/snapshot');
      return plain('not found', 404);
    }

    // /{token} — 浏览器 GET → 查看页;其它一律 capture
    // /{token}/任意路径 — 一律 capture
    const seg1End = path.indexOf('/', 1);
    const firstSeg = seg1End === -1 ? path.slice(1) : path.slice(1, seg1End);
    if (RESERVED_FIRST_SEGMENT.has(firstSeg)) return plain('not found', 404);
    if (!isValidToken(firstSeg)) return plain('not found', 404);

    const stub = env.SESSION.get(env.SESSION.idFromName(firstSeg));

    const isExactToken = path === '/' + firstSeg || path === '/' + firstSeg + '/';
    const accept = req.headers.get('accept') || '';
    const wantsViewer = method === 'GET' && isExactToken && accept.includes('text/html');

    if (wantsViewer) {
      const meta = await stub.fetch('https://do/meta');
      if (meta.status !== 200) return plain('会话不存在或已过期', 404);
      const m = await meta.json<{ expiresAt: number; host: string }>();
      const viewURL = `${url.protocol}//${m.host}/${firstSeg}`;
      return htmlResponse(renderViewer(firstSeg, viewURL, m.expiresAt, `${m.host}/${firstSeg}`));
    }

    const remainder = seg1End === -1 ? '/' : path.slice(seg1End);
    const fwdURL = new URL(req.url);
    fwdURL.pathname = `/capture${remainder}`;
    const fwd = new Request(fwdURL.toString(), req);
    fwd.headers.set('x-webreturn-client-ip', req.headers.get('cf-connecting-ip') || '');
    fwd.headers.set('x-webreturn-host', url.host);
    return stub.fetch(fwd);
  },
};

export { CallbackSession } from './session';
