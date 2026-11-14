# Agent Note: Same-host phone companion authorization

Status: implemented

English | [中文](2026-11-12-samehost-phone-companion-authorization.md)

## Problem

同一家庭网络中的手机需要正在运行的桌面 Host 的完整 Web UI——不是缩减的远程视图，也不是第二个 Host。复用浏览器启动令牌或其 cookie 会把进程级凭据交给一台会带出门、且无法按设备吊销的手机。为手机复制会话、队列或智能体状态会把一个运行时拆成两份。家庭局域网本身不是信任锚：网内任何设备都能触达监听器。

## Decision

[mobile-access 插件](../../../../packages/hemi/mobile-access/README.zh.md)为同一个 Host 增加一条已认证载体，而不是第二个运行时。其 TLS 监听组默认关闭；桌面所有者无需选地址，宿主自动在具体私网或链路本地 IPv4 候选上使用同一端口绑定，管理类 Remote 方法只应答桌面浏览器所有者 Peer（否则返回 `hemi-mobile/unauthorized`）。

- **载体复用。** HTTP 请求经 `connection.serveHttp` 进入，保留 `connection/request` 准入瀑布、请求体限制与响应背压；WebSocket 升级经 `typertGateway.websocket.acceptUpgrade` 转移，共用 Gateway mux、心跳、就绪门控与 Peer 释放。页面资源经 `webServer.readResource` 读取。不复制任何会话、队列或智能体实现。
- **配对。** 同一时刻只有一张有效邀请：32 字节一次性令牌（默认 120 秒），经二维码或复制转移，携带监听 origin 与手机固定（pin）的叶证书指纹。认领的手机出示自己的名称和自行生成的 32 字节 secret。批准是显式的：所有者比对双端屏幕上显示的六位数字码，并在请求发布 `approved` 之前先持久写入设备记录——名称、创建时间和 SHA-256 secret 哈希。
- **凭据。** 手机把 `deviceId` 与 `secret` 保存在 Keychain，并用 bearer 换取 `__Host-hemi-mobile` cookie（Secure、HttpOnly、SameSite=Strict）。Host 只保存 SHA-256 哈希，存于 DSH 凭据存储的 `hemi-mobile-access` scope；从不存储或发出 secret，也从不把浏览器启动令牌或 cookie 交给手机。
- **Peer。** 每台已批准设备认证到自己的 Peer，拥有完整 owner principal（`createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })`），因此手机是完整的所有者屏幕，不是查看者。吊销先删除持久记录——新请求立即认证失败——再释放 Peer 并关闭其 socket。目录默认最多容纳 10 台设备；配对认领按地址限速。

## Alternatives considered

- **为手机复用浏览器启动令牌或 cookie。** 启动令牌是进程级凭据，没有按设备的身份，也没有按设备的吊销；丢失手机意味着轮换 Host 凭据。败给带独立吊销的按设备哈希 secret。
- **为手机运行一份复制的 Host 表面。** 复制会话、队列和智能体状态会把运行时拆分并让持久化翻倍。败给复用现有载体。

## Consequences

代价：在[浏览器令牌](2026-08-24-browser-token-authentication.zh.md)与 [API connect 握手](2026-10-09-operator-scoped-connect-handshake.zh.md)之外多维护一条授权表面；手机固定（pin）自签名证书，证书改变需要新邀请，网卡改变需重启监听组；所有者承担手动批准与吊销。换来：可按设备吊销、Host 仅存哈希的凭据，手机从一个 Host 获得完整 Web UI，桌面权限不变——手机是额外的 owner Peer，Peer 与 principal 词汇仍归 [Peer principal 决策](2026-10-12-peer-principal-and-remote-access.zh.md)所有。

## Testing

`packages/hemi/mobile-access/tests` 中的套件钉住配对生命周期（一次性邀请、过期、先预留后提交的批准顺序、预留互斥）、监听器准入围栏（就绪前拒绝、外来 Host 与 Origin、畸形或超限请求体、突发）、已认证端点（cookie 签发、经设备 Peer 的 `/api`、升级转移、幂等停止）、记录与 wire 解析。Host 测试还覆盖读取中的缓存失效，以及并发启动、停止与释放。浏览器组合验证手机读取桌面的录制历史、向同一个 Session 提交消息，并在吊销后失去访问权。实际 iOS 验收仍未执行：WebKit 同源与固定证据来自 macOS，iOS 构建只证明编译成功，不代表真机行为（见[移动应用 README](../../../../apps/mobile/README.zh.md)）。
