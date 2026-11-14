# Hemi DSH 移动端（iOS 壳）

[English](README.md) | 中文

原生 iOS 壳：与同一 Wi-Fi 的 Hemi DSH Host 配对，并在 `WKWebView` 中展示该 Host 的完整 Web UI。第一版包含：连接流程（扫码或粘贴邀请、自动选择可达地址、自动发送一次配对请求、六位验证码、电脑显式批准）、pinned TLS，以及为页面 `window.__DSH_TRANSPORT__` 契约提供的原生 WebSocket 桥。不使用 React、Capacitor 与 Node 依赖。

## 目录结构

- `Package.swift`、`Sources/HemiMobileCore/` —— 纯 Swift 协议与策略逻辑：邀请解析、叶证书 pin、配对客户端、配对邀请 intake 与请求时限策略、origin 规则、桥脚本、Keychain 存储。在宿主机上单元测试。
- `Tests/HemiMobileCoreTests/` —— XCTest 覆盖注入 socket 桥与壳控制脚本的 JavaScriptCore 行为、配对协议字段，以及针对本地自签 TLS fixture 的真实 pinned WSS 连接（open→send→echo→close、重定向拒绝、错误 pin、服务端观测连接关闭）。
- `ios/App/` —— UIKit 应用（`ai.hemi.dsh.mobile`，显示名 “Hemi DSH”）：连接页、扫码、远端 Web UI 页、原生 socket 桥与壳控制脚本。
- `experiments/wk-tls-trust/` —— WKWebView 自签名信任实验及其结论（[README](experiments/wk-tls-trust/README.zh.md)）。
- `scripts/` —— 构建与测试入口，全部在本机实际执行后才写入本文。

## 配对协议（kind `hemi-dsh-mobile`，version 1）

邀请为 `{kind, version, origin, fingerprint, token, expiresAt}`，可附加同主机多地址的 `origins` 数组；`fingerprint` 为服务器叶证书 DER 的 SHA-256 小写十六进制。扫码或粘贴多地址邀请后，客户端探测一次候选并自动选择可达地址（`PairingClient.resolveInvitation`）；唯一的 pair POST、状态轮询、批准后的会话、远端 WebView 及其 socket 全部使用该选定地址，已保存会话在打开远端页前重新选择（`PairingClient.resolveSession`），对每一条可探测的已存地址做无凭据探测——单条已存地址也在内；`candidateOrigins` 缺失或不可解析时，按同一候选规则解析已存 origin——因此旧地址失效时能在数秒内得知不可达，而不用拖满凭据交换的预算；解析只确认或重排已知地址（绝不改动 pin、秘密，也绝不新增地址），选定地址存入 `candidateOrigins` 首位，该字段原本缺失的会话保持旧的单地址存储形态。客户端 `POST /mobile/pair` 发送 `{version, invitationToken, requestId, deviceName, secret}`，收到 `{requestId, verificationCode, status:'pending', expiresAt, serverName}`；轮询 `POST /mobile/pair/status`（`{requestId, secret}`），批准后用 `GET /mobile/session`（Bearer `<deviceId>.<secret>`）换取 `__Host-hemi-mobile` HttpOnly cookie，页面所有请求凭此认证。ZCode 的手机远控实现使用云中转；本壳与本机 Host 保持固定证书的局域网 TLS 直连，不向该中转发送流量。服务端细节见 `packages/hemi/mobile-access`。

## 安全模型

- TLS：所有原生连接与 WKWebView challenge 走同一套叶 pin 判定（`TLSPin.swift`）：pin 必须匹配、仅锚定被 pin 的叶证书、SSL host 策略、评估期间禁止网络取回。不匹配即 fail closed 并清除配对；只有新邀请能重新建立信任。
- 秘密处理：`deviceId`/`secret` 只存于 Keychain（`WhenUnlockedThisDeviceOnly`）与注入本屏独立 non-persistent WKWebView cookie store 的 HttpOnly cookie，绝不注入页面 JavaScript。
- 桥范围：`window.__DSH_TRANSPORT__`（`createWebSocket` + `streamBaseUrl`）仅在主帧 document start 注入；子帧或外部 origin 的命令在进入原生代码前被丢弃。WebSocket 只允许配对 host 与端口的 `wss://`，由带 cookie 头的 pinned `URLSessionWebSocketTask` 承载。壳控制全局 `window.__HEMI_MOBILE__`（`version`、`serverName`、`disconnect`）以同样方式注入：冻结且只读，不含 origin、secret 或 token，`serverName` 经 JSON 编码使页面可控文本无法注入脚本；其 `disconnect` 只发送一条固定消息，原生侧在同样的主帧与 origin 守卫之后路由，Web 设置页因此能关闭远端页，同时 Keychain 配对保留。同一脚本还会向页面文档安装一个自有 `<style>` 元素（`hemi-mobile-scroll-style`，标记 `data-hemi-mobile="scroll"`）——只在 DOMContentLoaded 安装一次（document start 注入时 head 尚不存在），重复注入不重复——内容只有本壳的滚动包含 CSS。
- 导航：主帧导航仅配对 origin 留在应用内；外部链接交给 Safari；子帧仅允许同源。远端页隐藏原生导航栏并将 WebView 对齐安全区，连接信息与断开放在 Web 设置页；系统返回手势与遮罩返回按钮仍是退出兜底。外层 WebView 与连接页不进行边界回弹，自有样式表对 Web 应用会话滚动宿主（`[data-conversation-scroll]`）与外层 `html`/`body` 链设置 `overscroll-behavior-y: none`，转录两端的惯性不会在聊天流内弹跳；不使用通配选择器、不拦截触摸，页内嵌套滚动区与文本域保持各自行为。长内容仍可正常滚动。
- 失败：解析通过的邀请自动启动且只启动一个配对 attempt——intake 在弹层 dismiss completion 中执行；attempt 存活期间再次提交同一邀请会保留该 attempt，而不是再发一次 pair POST；邀请 token 决定身份，origin 解析后重扫原始二维码仍保留存活 attempt。每个配对 attempt 只发送一次 pair POST，requestId、secret 与选定地址在 POST 之前即已保存。POST 结果未知——请求被中断、传输失败、预算到期或 2xx 但协议拒绝——时保留同一 attempt：界面进入本地 checking 状态，只在选定地址上轮询状态，绝不换址、绝不重发 pair；只有明确拒绝、过期、用户放弃或不同 token 的新邀请结束 attempt 后才允许新的 POST。origin 解析阶段的失败尚未发送任何内容，界面提供一次安全重试。所有协议请求——会话交换在内——都带同一固定 15 秒预算（每请求 timeout，外加设在客户端自有 configuration 副本上的整请求 resource 上限；调用方共享的 configuration 对象绝不被改动），不可达地址在数秒内落定，而不是等满系统默认的一分钟；超时或取消的交换不清除任何凭据、也不再发送任何请求，取消以 `CancellationError` 浮出。探测无候选应答时以类型化的 unreachable 失败（该 case 不携带 detail 字符串，地址与凭据形状的信息无从泄漏），超时以同 Wi-Fi 提示加重试与返回呈现，而非无限转圈。其他未知网络结果可见且绝不自动重试；只有幂等的 status 轮询重复（2 秒起步、+0.5 秒递增、5 秒封顶、429 时 +2 秒），在服务端报告的请求时限处结束——邀请自身过期不会终止仍存活的请求，没有 pair 回执的 attempt 不会本地超时。撤销（401）与证书变化要求重新配对。
- 生命周期：冷启动且已存配对时，连接页仅在首次出现时自动连接一次，先对已存地址做无凭据探测（单条已存地址也在内），旧地址失效或不可达时带着同 Wi-Fi 提示与扫码动作落回连接页，而不是占住远端页；已存连接进行中提供取消，取消会作废在跑任务的 ticket 并重置状态。从远端页返回——返回手势、主动断开或 fail-closed——绝不自动重连，退后台仍保留远端页面、草稿与滚动位置，页面内 DSH ConnectionController 通过桥自行重连。忘记设备会关闭 socket、移除用户脚本与消息处理器、停止加载、删除 cookie 并等待删除完成、清空 Keychain 条目；返回手势同样触发该 quiescent teardown，已取消的 bootstrap 不再能安装 cookie 或加载页面。远端页 bootstrap 加载中或失败后，遮罩上都有走同一断开路径的返回按钮——Keychain 配对保留，只关闭页面——系统返回手势从来不是唯一出口。

## 构建与测试

```sh
cd apps/mobile
./scripts/test-core.sh            # shared logic and real pinned-WSS tests
./scripts/build-simulator.sh      # iphonesimulator compile + link, unsigned
./scripts/build-device-unsigned.sh  # generic iOS device compile + link, unsigned
```

脚本使用全新临时构建目录，Swift 测试也使用独立 scratch 路径，避免复制工作区后复用绑定旧 SDK 路径的模块缓存。开发时用 Xcode 打开 `ios/App/App.xcodeproj`；`ios/debug.xcconfig` 可选包含用户自有的 `signing.local.xcconfig` 作为本地签名覆盖——该 include 在文件存在时会被读取，请保持其仅存在于本地、绝不提交。

## 借用代码

二维码扫码、Keychain 存储模式与 pinned TLS 校验改编自上一代 Hemi 移动壳（MIT，© 2026 PiuQiuPiaQia）：`HemiScannerController`（旧 `HemiBotPlugin.swift` 243-281 行）、`HemiKeychainStore`（旧 `HemiDeviceClient.swift` 45-62 行）、`hemiPinnedTLS`（82-99 行）。旧 `flow.*` 协议、P256 Bot 签名与手写 HTTP/1.1 Content-Length 解析器刻意不迁移；DSH 的 multipart 与流式响应由 URLSession 原生处理。

## 已知限制与真机缺口

- 开发签名版已在 iPhone 17 Pro Max 安装启动。用户完成配对，现有桌面 Host 显示手机已连接。此前的「冷启动一直正在连接电脑」已定位成因而非未知错误：Host 地址跨网段变更后，已存会话仍指向旧地址且不可达，恢复流程却把凭据会话交换无预算地挂住、遮罩上也没有出口。本版把该路径改为快速失败且可取消（单条已存地址在内的无凭据探测、固定请求预算、遮罩返回按钮、已存连接取消），但针对真实不可达 Host 的恢复仍需在新版真机上验收。
- 无 simulator runtime 时 asset catalog 无法编译（actool 依赖模拟器服务），因此 `Assets.xcassets` 暂不从目标构建。借用的应用图标经 legacy `CFBundleIcons`/`CFBundleIconFiles` 以预渲染 PNG 随 bundle 提供（不依赖 actool，未新增图形）；主屏渲染尚未在真机验证。
- 真机安装需要匹配的开发描述文件、开发者模式与明确的开发者信任。独立 bundle id `ai.hemi.dsh.mobile` 不替换旧 `ai.hemi.mobile` 应用；开发签名按其描述文件到期。
- 取消待处理配对仅停止客户端轮询；协议无取消端点，邀请由服务端自然过期。
- 远端页自身暂无应用内错误面板：页面内失败经由 DSH Web UI 呈现，原生失败经由遮罩与弹窗呈现。
- `Info.plist` 的用途说明字符串为中英单条双语；按语言拆分 `.lproj` 延后。
- 配对页保留核码与安全的状态确认，正常流程不展示 IP、证书或过期诊断信息。传输失败日志只含协议路径与系统错误标识，不含邀请或凭据字节；查询停止时不显示忙碌转圈。
- 远端页不绘制原生导航：页面在顶层时隐藏导航栏，返回连接页时恢复；连接信息与断开经 `window.__HEMI_MOBILE__` 移入 Web 设置页。隐藏栏后的安全区渲染、键盘遮挡、冷启动自动连接、页内断开与转录两端滚动包含仍需真机验收。
