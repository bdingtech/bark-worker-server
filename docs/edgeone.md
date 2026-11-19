# EdgeOne 直连 APNs（实验性）

本文件描述 [bdingtech/bark-worker-server](https://github.com/bdingtech/bark-worker-server) 里的 EdgeOne 部署。GitHub Wiki 不随 fork 的代码一起修改；上游 Wiki 仍然是旧的 Node Functions 反代说明，不要照着它为本 fork 配置反代。

许可仍是 GPLv3，见仓库根目录 `LICENSE.txt`。

## 当前结论

EdgeOne 边缘函数会带上官方文档中的 `RequestInit.version = "HTTP/2.0"`，直接 `POST https://<APNs 主机>/3/device/<device-token>`。默认主机是 `api.push.apple.com`，端口 443。没有 Node Functions，也没有到 `api.day.app` 或其他中继的回退。

这不能当成“EdgeOne 已经能够直连 APNs”的验证结果。本地单测只检查请求怎么组装、错误怎么返回，以及代码不再调用旧反代。构建通过只说明产物能生成。EdgeOne 运行时是否真的用 HTTP/2 和 TLS 1.2 把请求送到 APNs，必须在你自己的 EdgeOne 项目里看诊断结果和一次真实推送。

依据和边界：

- APNs 要求使用 HTTP/2 和 TLS 1.2 或更高版本连接 `api.push.apple.com:443`（也可用 2197）。请求方法是 POST，路径是 `/3/device/<device-token>`，token 认证时要带 `authorization: bearer <provider token>`，并且要带 `apns-topic`。见 [Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)。
- EdgeOne 边缘函数的 [Request](https://cloud.tencent.com/document/product/1552/81902) 把 `version` 列为 `HTTP/1.0`、`HTTP/1.1`、`HTTP/2.0`，默认是 `HTTP/1.1`。国际站对应页面标注的更新时间是 2026-11-04，并写了 AI 辅助审校。文档列出选项，不等于线上 fetch 对公网主机已经协商出 HTTP/2。
- 控制台里的 [HTTP/2](https://cloud.tencent.com/document/product/1552/70780) 是客户端访问 EdgeOne。 [HTTP/2 回源](https://cloud.tencent.com/document/product/1552/71008) 是站点回源。这两项都不是边缘函数主动请求 APNs 的出站协议。打开它们不能证明本实现可用。
- V2EX 上 1 月 20 日的帖子里，腾讯回复 Edge Functions 的 fetch HTTP/2 仍依赖底层架构、还在规划。帖子页面没有印年份；上游在 2026-01-24 提交了 Node Functions 反代，处理的是同一限制。当天的上游 Wiki 仍写明必须反代，并预计 2026 年上半年解决。这次实现没有找到后续官方公告，证明该出站限制已经解除或 APNs 送达已验证。
- 同一份 Request 文档里的 `eo.tls` 是客户端证书、私钥和 CA，不是最低 TLS 版本。代码没有设置 TLS 1.2，也没有配置客户端证书。

如果运行时忽略 `version`，或者仍然只发出 HTTP/1.1，APNs 会拒绝连接。推送会失败并把错误返回。代码不会改走 Node 反代，也不会把请求转到 `api.day.app`。

## 和旧 EdgeOne 部署的差异

| 项目 | 旧实现 | 本 fork |
| --- | --- | --- |
| APNs 出口 | 边缘函数把一批请求 POST 到同域名的 Node Function `/bark-node<URL_PREFIX>/apns-proxy`，由 `got` 以 HTTP/2 代发 | 边缘函数直接 fetch APNs |
| `URL_PREFIX` | 构建必填，且不能为 `/`，同时充当 API 前缀和反代路径 | 仍然是 API 前缀，并决定边缘函数文件目录。可以不设，此时为 `/`。不再为反代服务 |
| `PROXY_TOKEN` | 边缘函数调用 Node Function 时的口令；构建时缺失会生成并写进产物 | 不再读取、不再生成。可以删掉 |
| `APNS_URL` | 一旦设置，边缘函数改为不经反代的普通 fetch；未设置时才走 Node Function | 只作为 APNs 主机名覆盖。有没有设置，都带 `HTTP/2.0` 选项。它不是中继开关 |
| Cloudflare、ESA、Node | 普通 fetch，无 `version` 选项 | 不改 |

`URL_PREFIX` 仍有两个作用，不要当成废弃配置：

1. Bark App 里的服务器路径。`/bark` 对应 `https://你的域名/bark`。
2. 构建时把函数放到 `edge-functions/bark/[[default]].js`，让无关 URL 不触发函数。EdgeOne Pages 的请求额度会被实际进入边缘函数的访问消耗；前缀仍然可以缩小触发范围。

不设置 `URL_PREFIX` 时，产物是 `edge-functions/[[default]].js`，函数挂在整个主机上。

构建期和运行期的 `URL_PREFIX` 必须一致，并且改完要重新部署。只改运行期变量、不重新构建时，文件目录和 Hono 的 `basePath` 会错开，`/info` 会找不到。

`APNS_URL` 只接受主机名，可带端口，例如 `api.push.apple.com` 或 `api.push.apple.com:2197`。不要写成 `https://...`。2197 只是 APNs 文档中的可选端口，不是已经验证的绕过办法。

## 环境变量

保留并继续按原意使用：

- `DB_NAME`：KV 绑定名。EdgeOne 默认 `BARK_KV`。
- `ALLOW_NEW_DEVICE`：默认允许新设备。`false` 关闭注册。
- `ALLOW_QUERY_NUMS`：默认允许 `/info` 返回设备数。
- `MAX_BATCH_PUSH_COUNT`：批量推送上限。直连后每个设备各占一次边缘函数出站 fetch。
- `BASIC_AUTH`：保护 `/info`。探测开启时也会保护诊断 POST。格式仍是 `用户名:密码`，不要写进仓库。
- `URL_PREFIX`：见上一节。
- `APNS_URL`：可选 APNs 主机名。

删除或不再依赖：

- `PROXY_TOKEN`：留在项目里也不会被读取。建议从 EdgeOne 环境变量中删除，避免以后误以为反代还在。

新增、默认关闭：

- `APNS_TRANSPORT_PROBE`：只有精确等于 `true` 时，对诊断路径发 POST 才会访问 APNs。测完改回删除或非 `true` 并重新部署。

Cloudflare、ESA、Node 不读取 `APNS_TRANSPORT_PROBE`。它们的 `URL_PREFIX` 和 `APNS_URL` 行为与这次改动之前相同。

## 部署

1. 使用本 fork 的这次改动，不要按上游仓库当前的 EdgeOne Wiki 去配 Node 反代。
2. 在 EdgeOne KV 控制台创建一个命名空间。
3. 在 EdgeOne Pages 导入本 fork。`edgeone.json` 仍会执行 `pnpm install --frozen-lockfile && npm run build:eo`。构建配置不用为反代额外加命令。
4. 环境变量按需设置。可以不设置 `URL_PREFIX`。不要设置 `PROXY_TOKEN`。先不要设置 `APNS_TRANSPORT_PROBE`。
5. 部署完成后，在项目设置里绑定 KV。变量名用 `BARK_KV`，若设置了 `DB_NAME` 就用同一个名字。
6. 绑定后再部署一次。
7. 如果控制台里还留着旧的 Node Function 路由 `bark-node/.../apns-proxy`，删掉它再部署。新的构建不会再生成 `node-functions`。

部署本身不会发送 APNs 或 Bark 通知。

## 不携带敏感信息的检查

下面的命令把域名和前缀换成你的值。不要把 device key、device token、JWT、私钥、Basic 密码或通知正文贴到日志、工单或聊天里。如果响应里意外出现这些内容，先停止转发响应原文。

前缀为空：

```bash
curl -sS "https://example.com/info"
curl -sS "https://example.com/_diag/apns-transport"
```

`URL_PREFIX=/bark`：

```bash
curl -sS "https://example.com/bark/info"
curl -sS "https://example.com/bark/_diag/apns-transport"
```

`/info` 应返回 JSON，`arch` 为 `js/edgeone`。这只说明边缘函数和 KV 读路径起来了，不说明 APNs 可用。

诊断 GET 不访问 APNs。预期类似：

```json
{
  "experimental": true,
  "mode": "edgeone-direct",
  "relay": false,
  "requestedHttpVersion": "HTTP/2.0",
  "probe": "disabled",
  "deliveryVerified": false
}
```

`relay` 必须是 `false`。`deliveryVerified` 在这个接口里永远是 `false`。

需要看运行时有没有把请求送到 APNs 时，才把 `APNS_TRANSPORT_PROBE` 设为 `true` 并重新部署，然后：

```bash
curl -sS -X POST "https://example.com/_diag/apns-transport"
```

如果配置了 `BASIC_AUTH`，诊断 POST 也要带它。密码使用你已经配置的值，不要写进命令历史后随意外传：

```bash
curl -sS -X POST -u '用户名:密码' "https://example.com/_diag/apns-transport"
```

这次 POST 会从 EdgeOne 向 APNs 主机发一个请求。它使用固定的无效 device token，不读数据库里的设备，不接收你在查询串或正文里传入的 token，也不带 provider token，因此不能把通知送到手机。请求仍会到达 Apple。测完后关闭 `APNS_TRANSPORT_PROBE` 并重新部署。未配置 `BASIC_AUTH` 时，知道这个 URL 的人也可以触发该探测。

结果怎么读：

| 结果 | 含义 |
| --- | --- |
| GET，`probe` 为 `disabled` | 没有访问 APNs。部署入口正常。 |
| POST 返回 401 | 探测被 Basic Auth 拦住，没有访问 APNs。 |
| `transport` 为 `network-error` | fetch 抛错。常见于出站协议不被接受、连接超时或主机名不对。直连尚未可用。不要把它当成送达。 |
| `transport` 为 `apns-response`，`httpStatus` 403，`apnsReason` 为 `MissingProviderToken` | 收到了 APNs 风格的 HTTP 响应。这与“对端按 APNs 接口解析了这个未认证请求”一致，但仍不能单独证明协商的是 HTTP/2、TLS 版本，更不能证明手机会显示通知。 |
| 其他 HTTP 状态、HTML 或无法识别的正文 | 不要当成直连成功。 |

探测通过之后，再用 Bark iOS 客户端注册一台设备并发送一条你自己的测试通知。那一步才覆盖 provider token、topic、设备 token 和真实 payload。本仓库的自动化测试没有做这件事。

诊断响应会去掉 device token、`bearer` 和看起来像 JWT 的片段。自定义 `APNS_URL` 只以 `customApnsHost: true/false` 出现，不回显主机名。

## 本地命令和线上验证不是同一件事

在仓库里可以重复：

```bash
pnpm test
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec tsc --noEmit -p tests/tsconfig.json
pnpm build:eo
URL_PREFIX=/bark pnpm build:eo
pnpm build:cf
pnpm build:esa
```

`pnpm test` 使用 mock fetch，不会连接 Apple。`build:eo` 不加 `URL_PREFIX` 时应把函数写到 `edge-functions/[[default]].js`；`URL_PREFIX=/bark` 时应写到 `edge-functions/bark/[[default]].js`，并且没有 `node-functions`。这些命令通过，只说明单测和构建通过。

`pnpm build:node` 在 master 上也会失败：Rsbuild 把 `@hono/node-server` 的 `http` / `http2` 内置模块当成客户端代码。这不是这次 EdgeOne 改动引入的，Node 运行入口的代码没有改。

EdgeOne 上的出站 HTTP/2、TLS 版本和 APNs 送达都还没有在本变更中测试。

## 已知限制

- 直连是实验行为。运行时若不具备 HTTP/2 出站，推送失败是预期结果，不是实现完成的证明。
- 没有自动回退到 Node Functions、`PROXY_TOKEN`、`api.day.app` 或其他中继。
- 代码不能配置最低 TLS 版本。APNs 要求 TLS 1.2 或更高，这仍要靠运行时和实测。
- 出站超时显式设为连接 10 秒、读 20 秒、写 20 秒，对应 Request 文档里的 `eo.timeoutSetting`。超时错误名通常是 `net_exception_connect_timeout` 或 `net_exception_timeout`。
- 边缘函数单次运行最多 64 次 fetch，并发最多 8。旧反代在一次推送里只让边缘函数发出 1 次 fetch，批量再由 Node Function 发出。现在每个设备各 1 次出站 fetch。批量请把 `MAX_BATCH_PUSH_COUNT` 控制在 64 以内。
- 官方 Bark iOS 的注册、device key、KV、通知字段和错误码仍走原来的 API。其他平台的构建入口还在。
- `/info` 的设备数仍然不可靠，KV 写入后也可能要等几秒才能推送。这两点是原有限制。
