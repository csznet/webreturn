# webreturn

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/csznet/webreturn)

开发用的两件套:

1. **回调捕获** — 点一下按钮拿到临时 URL,所有打到这个地址的请求实时滚动显示(Method / URL / Query / Header / Body)。适合调试 webhook、OAuth 回调、IoT 上报。
2. **在线请求测试** — 网页版 Postman:输入 URL、选 method、改请求头/Body,看响应。免装客户端,首页第二个卡片就是入口。

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

最快 — 直接点最上面的「Deploy to Cloudflare Workers」按钮,跟着引导授权 + Fork 即可。

或者本地命令行:

```bash
git clone https://github.com/csznet/webreturn.git
cd webreturn
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
| `/` | 首页(两个工具入口) |
| `/v/{token}` | 实时查看页(浏览器打开) |
| `/{token}` 或 `/{token}/任意/路径` | **回调捕获入口**(任意 method,任意 Accept) |
| `/test` | 在线请求测试(Postman 风格 UI) |
| `/api/sessions` | `POST` 创建会话 |
| `/api/sessions/{token}/events` | SSE 实时流 |
| `/api/sessions/{token}/requests` | 历史快照 JSON |
| `/api/proxy` | `POST` JSON,代理转发请求(供 `/test` 页面调用) |

### 怎么工作的

每个 token 对应一个 **Durable Object** 实例:

- 单线程串行处理,创建时原子地 claim token(并发同 token 一定有一个返回 collision,Worker 自动换号重试)
- 用 DO 内置 storage 持久化最近 200 条请求 + 元数据,实例淘汰/重启不丢
- SSE 连接由 DO 直接 hold,新请求落地时同步广播给所有订阅者
- 用 DO `setAlarm` 在 TTL 到期时自动触发 `purge` 清理状态

### 限制

- 单条 body 超过 1 MiB 会被截断(可在 `src/session.ts` 改 `MAX_BODY`)
- Workers 的请求最多持续 ~15 min,SSE 会定时断开;前端会自动指数退避重连,不影响使用
- 客户端 IP 用 `CF-Connecting-IP` 头取(Cloudflare 自动注入)

---

## 在线请求测试 (`/test`)

首页第二个卡片进入,UI 类似 Postman / Hoppscotch:

- 顶部 method 下拉(GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS)+ URL 输入框 + 「发送」
- Tab:`Params`(自动拼到 URL)/ `Headers`(键值对)/ `Body`(文本 + Content-Type 快捷选择 JSON / Form / Text / XML)
- 响应面板显示 状态码 + 耗时 + 大小 + Body(JSON 自动 pretty-print)+ Headers
- 历史记录最近 20 条放在 `localStorage`,点一下复用

### 工作原理

浏览器把请求参数 POST 给 `/api/proxy`,Worker / Go 服务端用 `fetch()` / `http.Client` 转发到目标 URL,把响应包成 JSON 返回。这样绕过浏览器的 CORS 限制,任何 URL 都能测。

### 安全(SSRF 防护)

- 仅允许 `http` / `https` scheme
- 拒绝主机名:`localhost`、`metadata.*`、`*.localhost` / `*.internal` / `*.local`
- 拒绝 IP 段:`127.x` / `10.x` / `172.16-31.x` / `192.168.x` / `169.254.x`(链路本地 + AWS metadata)/ `0.0.0.0` / 多播 / IPv6 ULA / IPv6 link-local
- Go 端额外用自定义 `DialContext` 在解析后再校验一次 IP,防 DNS rebinding
- 单次请求 / 响应 body 上限 5 MiB,30 秒超时,最多跟 5 次重定向

### 局限

- Worker 版每次代理都会消耗一个请求(免费版 10 万/天),滥用风险存在但量级有限
- 二进制响应会以 base64 形式返回(前端会标注)
- 不做服务端频控(可自行加 `RateLimitDO` 或反向代理层处理)

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
├── proxy.go              # /api/proxy 代理实现 + SSRF 防护
├── templates/            # Go 版前端模板(embed 进二进制)
│   ├── home.html
│   ├── viewer.html
│   └── test.html
├── wrangler.toml         # Cloudflare Workers 配置
├── package.json
├── tsconfig.json
└── src/                  # Workers 版源码
    ├── worker.ts         # Worker 入口、路由、token 分配、proxy
    ├── session.ts        # CallbackSession Durable Object
    ├── home.html
    ├── viewer.html
    └── test.html
```

两套实现完全独立 — Go 端只看 `*.go` + `templates/`,Worker 端只看 `src/` + 三个根配置。两边都放在仓库根方便 Cloudflare deploy 按钮直接识别。

---

## License

MIT
