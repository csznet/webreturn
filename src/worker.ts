import HOME_HTML from './home.html';
import VIEWER_HTML from './viewer.html';
import TEST_HTML from './test.html';

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
const RESERVED_FIRST_SEGMENT = new Set(['', 'v', 'api', 'test', 'favicon.ico', 'robots.txt']);

const MAX_PROXY_BODY = 5 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 30_000;
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-length',
]);

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

function isProxyURLAllowed(s: string): { ok: true; url: string } | { ok: false; error: string } {
  s = s.trim();
  if (!s) return { ok: false, error: 'URL 不能为空' };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, error: 'URL 格式错误' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '仅支持 http / https' };
  if (!u.hostname) return { ok: false, error: 'URL 缺少 host' };
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === 'metadata' ||
      host === 'metadata.google.internal' || host === 'metadata.azure.com') {
    return { ok: false, error: `拒绝访问主机: ${host}` };
  }
  for (const suf of ['.localhost', '.internal', '.local']) {
    if (host.endsWith(suf)) return { ok: false, error: `拒绝访问主机: ${host}` };
  }
  // IPv4 数字地址检查
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = +ipv4[1], b = +ipv4[2];
    if (a === 0 || a === 127 || a === 10) return { ok: false, error: `拒绝访问 IP: ${host}` };
    if (a === 172 && b >= 16 && b <= 31) return { ok: false, error: `拒绝访问 IP: ${host}` };
    if (a === 192 && b === 168) return { ok: false, error: `拒绝访问 IP: ${host}` };
    if (a === 169 && b === 254) return { ok: false, error: `拒绝访问 IP: ${host}` };
    if (a >= 224) return { ok: false, error: `拒绝访问 IP: ${host}` };
  }
  // IPv6 粗略检查
  if (host.includes(':')) {
    if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
      return { ok: false, error: `拒绝访问 IP: ${host}` };
    }
  }
  return { ok: true, url: u.toString() };
}

function isTextCT(ct: string): boolean {
  const t = ct.toLowerCase().split(';')[0].trim();
  if (!t) return true;
  if (t.startsWith('text/')) return true;
  if (t.endsWith('+json') || t.endsWith('+xml')) return true;
  return ['application/json', 'application/javascript', 'application/xml',
    'application/x-www-form-urlencoded', 'application/x-ndjson', 'application/graphql'].includes(t);
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

async function handleProxy(req: Request): Promise<Response> {
  let pr: { method?: string; url?: string; headers?: [string, string][]; body?: string };
  try { pr = await req.json(); } catch {
    return Response.json({ error: '请求 JSON 解析失败' });
  }

  const check = isProxyURLAllowed(pr.url || '');
  if (!check.ok) return Response.json({ error: check.error });

  const method = (pr.method || 'GET').toUpperCase();
  const headers = new Headers();
  let hasUA = false;
  for (const kv of pr.headers || []) {
    if (!Array.isArray(kv) || kv.length < 2) continue;
    const k = kv[0]?.trim();
    if (!k) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers.append(k, kv[1] ?? '');
    if (k.toLowerCase() === 'user-agent') hasUA = true;
  }
  if (!hasUA) headers.set('User-Agent', 'webreturn-proxy/1.0');

  const init: RequestInit = { method, headers, redirect: 'follow' };
  if (pr.body && method !== 'GET' && method !== 'HEAD') init.body = pr.body;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROXY_TIMEOUT_MS);
  init.signal = ac.signal;

  const start = Date.now();
  let resp: Response;
  try {
    resp = await fetch(check.url, init);
  } catch (e) {
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    return Response.json({ error: (e as Error).message || '请求失败', elapsed_ms: elapsed });
  }
  clearTimeout(timer);
  const elapsed = Date.now() - start;

  const buf = await resp.arrayBuffer();
  const truncated = buf.byteLength > MAX_PROXY_BODY;
  const slice = truncated ? buf.slice(0, MAX_PROXY_BODY) : buf;
  const ct = resp.headers.get('content-type') || '';
  const text = isTextCT(ct);
  const bodyStr = text
    ? new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(slice)
    : bytesToBase64(new Uint8Array(slice));

  const respHeaders: [string, string][] = [];
  resp.headers.forEach((v, k) => respHeaders.push([k, v]));

  return Response.json({
    status: resp.status,
    status_text: resp.statusText,
    elapsed_ms: elapsed,
    headers: respHeaders,
    body: bodyStr,
    body_size: buf.byteLength,
    truncated,
    binary: !text,
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

    // 在线请求测试页
    if (path === '/test' && method === 'GET') {
      return htmlResponse(TEST_HTML);
    }

    // 代理转发
    if (path === '/api/proxy' && method === 'POST') {
      return handleProxy(req);
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
        return new Response(null, { status: 303, headers: { Location: `/v/${token}` } });
      } catch (e) {
        return plain(String((e as Error).message), 503);
      }
    }

    // 查看页 — /v/{token},仅 GET
    if (path.startsWith('/v/') && method === 'GET') {
      const token = path.slice(3).replace(/\/$/, '');
      if (!isValidToken(token)) return plain('not found', 404);
      const stub = env.SESSION.get(env.SESSION.idFromName(token));
      const meta = await stub.fetch('https://do/meta');
      if (meta.status !== 200) return plain('会话不存在或已过期', 404);
      const m = await meta.json<{ expiresAt: number; host: string }>();
      const captureURL = `${url.protocol}//${m.host}/${token}`;
      return htmlResponse(renderViewer(token, captureURL, m.expiresAt, `${m.host}/${token}`));
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

    // 捕获 — /{token} 或 /{token}/任意路径(任意 method)
    const seg1End = path.indexOf('/', 1);
    const firstSeg = seg1End === -1 ? path.slice(1) : path.slice(1, seg1End);
    if (RESERVED_FIRST_SEGMENT.has(firstSeg)) return plain('not found', 404);
    if (!isValidToken(firstSeg)) return plain('not found', 404);

    const stub = env.SESSION.get(env.SESSION.idFromName(firstSeg));
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
