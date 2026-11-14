# WKWebView 自签名 TLS 信任实验

[English](README.md) | 中文

回答一个问题的可执行实验：`WKWebView` 导航代理为主帧接受自签名证书后，同源子资源能否加载，子资源是否还会进入 `webView(_:didReceive:completionHandler:)`？

## 结论（本机，macOS WebKit，Xcode 26.6）

- 正确 pin（`SHA256(DER)`、anchor-to-leaf、SSL host 策略）：主帧一次 challenge 即接受；fetch、重定向 fetch、XHR、传统 script、ES module、CSS（规则实际生效）、图片、woff2 字体、同源 iframe 全部加载成功且未再触发 challenge——接受的信任覆盖同源子资源。
- 同一 host 的 `wss://` 通过同一导航代理抛出自己的 serverTrust challenge，按 pin 接受后完成 open+send+echo。
- 错误 pin（翻转首字符）：所有 challenge 一律 cancel，导航失败且不发出任何请求，fail closed。

生产桥仍由原生（带 cookie 的 pinned `URLSessionWebSocketTask`）承载 WebSocket，不依赖 WebKit 的 `wss` 行为。

## 组成

- `server.py` —— 本地 HTTPS 服务，动态生成自签名叶证书，记录请求日志，完成一次 WebSocket echo。
- `main.swift` —— 最小 AppKit WKWebView 客户端，与正式 App 完全相同的 pin 逻辑；记录每个 challenge 与子测试结果，自动退出。
- `run.sh` —— 生成证书与生成型素材、启动服务、以正确 pin 与错误 pin 各跑一次客户端，输出到 `results/`。
- `assets/` —— 子测试页面与素材；`img.png` 与 `font.woff2` 由 `run.sh` 生成，不提交。

## 运行

```sh
cd apps/mobile/experiments/wk-tls-trust && ./run.sh
```

`results/client-*.log` 的标记：`CHALLENGE`（代理被咨询）、`RESULT`（单个子测试）、`SUMMARY`（最终统计）。

## 平台说明

本机没有 iOS 模拟器 runtime（0 个镜像，剩余约 8 GiB），且 runtime 镜像（约 8 GiB）放不下，因此自动化运行在 macOS WebKit 上执行完全相同的信任代码。有 runtime 后请在模拟器或真机复跑：同一套判定逻辑位于 `Sources/HemiMobileCore/TLSPin.swift`。`results/` 含每次运行的 pin 与原始日志，不提交。
