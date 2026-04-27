# webreturn

开发用的 HTTP 回调捕获工具。点一下按钮拿到一个临时 URL,所有打到这个地址的请求都会实时滚动展示出来 — Method、URL、Query、Header、Body 一应俱全。适合调试 webhook、OAuth 回调、第三方推送、IoT 上报等需要"看一眼对方到底发了啥"的场景。

支持两种部署方式,选一种即可:

| 部署方式 | 区分会话的方式 | 适用场景 |
|---|---|---|
| **自托管 (Go)** | 每个会话一个**随机端口** | 内网/局域网/本机调试,不想买域名/CF |
| **Cloudflare Workers** | 每个会话一个**短 path token** | 想要公网 HTTPS 地址、零运维、按量计费 |

Token 都是先发 4 位纯数字(`/1234`),池子拥挤后自动扩成 4/5/6 位字母数字。

---

## 自托管 (Go)

需要 Go 1.21+。

```bash
git clone https://github.com/csznet/webreturn.git
cd webreturn
go build -o webreturn .
./webreturn
```

打开 http://localhost:8080 → 点「生成回调地址」→ 跳到查看页 → 把页面顶部的 `http://IP:端口` 拿去用。

### Flags

| Flag | 默认 | 说明 |
|---|---|---|
| `-listen` | `:8080` | UI 服务监听地址 |
| `-ttl` | `1h` | 默认会话有效期 |
| `-max-body` | `1048576` | 单请求最大记录 body 字节数(超出截断) |
| `-host` | (空) | 对外公开主机名/IP(留空则按访问页面时的 Host 自动推断) |

### 几个常见命令

```bash
./webreturn -listen :9000 -ttl 30m       # 换个 UI 端口、缩短默认有效期
./webreturn -host 192.168.1.10           # 强制对外用某个 IP(走反向代理时有用)
./webreturn -max-body 5242880            # 单条 body 上限 5 MiB
```

### 怎么工作的

1. 主进程在 `-listen` 上挂 UI + API
2. 每次创建会话:`net.Listen("tcp", ":0")` 抢一个空闲端口、起一个独立的 HTTP server,绑到这个 token
3. 任何打到该端口的请求(任意 path、任意 method)都被记录,通过 SSE 实时推到查看页
4. TTL 到期后 `Server.Shutdown` 关停监听器,SSE 客户端收到 `event: expired` 后停止重连

> ⚠️ 用在公网时记得防火墙允许动态端口段(默认是系统的临时端口范围,Linux 一般 32768–60999,Windows 49152–65535)。

---

## Cloudflare Workers

零成本公网 HTTPS,免运维。需要一个 Cloudflare 账号 — Durable Objects 在 Workers 免费版即可使用(基于 SQLite 后端)。

### 部署

```bash
cd cloudflare
npm install
npx wrangler login           # 浏览器登录授权
npx wrangler deploy
```

部署完会得到一个 `https://webreturn.<你的子域>.workers.dev` 地址。打开它,点按钮就行。

### 自定义域名(可选)

在 Cloudflare Dashboard → Workers → 选中 webreturn → Settings → Triggers → Custom Domains 加上 `cb.example.com` 之类。回调地址就会变成 `https://cb.example.com/{token}`。

### 改默认 TTL

```bash
npx wrangler deploy --var DEFAULT_TTL:30m
```

或直接改 `wrangler.toml` 里的 `[vars]` 段。

### URL 结构

| 路径 | 用途 |
|---|---|
| `/` | 首页(生成入口) |
| `/v/{token}` | 实时查看页 |
| `/{token}` 或 `/{token}/任意/路径` | **回调捕获入口**(任意 method) |
| `/api/sessions` | `POST` 创建会话 |
| `/api/sessions/{token}/events` | SSE 实时流 |
| `/api/sessions/{token}/requests` | 历史快照 JSON |

### 怎么工作的

每个 token 对应一个 **Durable Object** 实例:

- 单线程串行处理,创建时原子地 claim token(并发同 token 一定有一个返回 collision,Worker 自动换号重试)
- 用 DO 内置 storage 持久化最近 200 条请求 + 元数据,实例淘汰/重启不丢
- SSE 连接由 DO 直接 hold,新请求落地时同步广播给所有订阅者
- 用 DO `setAlarm` 在 TTL 到期时自动触发 `purge` 清理状态

### 限制

- 单条 body 超过 1 MiB 会被截断(可在 `cloudflare/src/session.ts` 改 `MAX_BODY`)
- Workers 的请求最多持续 ~15 min,SSE 会定时断开;前端会自动指数退避重连,不影响使用
- 客户端 IP 用 `CF-Connecting-IP` 头取(Cloudflare 自动注入)

---

## 捕获到的数据示例

```json
{
  "id": "a1b2c3d4e5f6a1b2",
  "timestamp": "2026-04-27T10:08:01.467Z",
  "remote_addr": "203.0.113.42:60342",
  "method": "POST",
  "url": "/webhook/event",
  "path": "/webhook/event",
  "raw_query": "",
  "query": {},
  "headers": {
    "Content-Type": ["application/json"],
    "User-Agent": ["curl/8.4.0"],
    "X-Custom": ["yes"]
  },
  "host": "192.168.1.10:65466",
  "proto": "HTTP/1.1",
  "body": "{\"event\":\"ping\",\"payload\":{\"x\":42}}",
  "body_size": 35,
  "truncated": false
}
```

回调端点对所有方法都返回:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"received":true,"request_id":"a1b2c3d4e5f6a1b2","captured_at":"2026-04-27T10:08:01.467Z"}
```

---

## 项目结构

```
webreturn/
├── main.go               # Go 版入口、flag、路由
├── session.go            # 会话管理、随机端口分配、capture 处理
├── handlers.go           # UI / API HTTP handler、SSE
├── templates/            # Go 版前端模板(embed 进二进制)
│   ├── home.html
│   └── viewer.html
└── cloudflare/           # Cloudflare Workers 版本
    ├── wrangler.toml
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── worker.ts     # Worker 入口、路由、token 分配
        ├── session.ts    # CallbackSession Durable Object
        ├── home.html
        └── viewer.html
```

两套实现完全独立,改一边不会影响另一边。

---

## License

MIT
