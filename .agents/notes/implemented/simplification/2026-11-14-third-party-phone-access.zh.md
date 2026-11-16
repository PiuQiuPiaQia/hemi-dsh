# Agent Note: Third-party phone access

Status: implemented

[English](2026-11-14-third-party-phone-access.md) | 中文

## Problem

手机访问需要安全连接到现有桌面 Host，不能复制会话或智能体状态。[自研配套应用决策](../../archived/architecture/2026-11-12-samehost-phone-companion-authorization.md)增加了一套需要维护的配对协议、TLS 监听器、设备目录、设置页和 iOS 应用。用户已使用 dsh-pocket，并选择使用该插件，不再维护自研配套应用。

## Decision

Hemi 不内置自研手机访问服务或 iOS 配套应用。第三方插件负责各自的手机客户端、认证和网络隧道。Hemi 保留 Desktop 及其他现有消费者使用的原生 Web HTTP 和 WebSocket 路由、浏览器认证和通用传输钩子。

Hemi Desktop 通过 [profile 适配器](../../../../packages/hemi/customizations/README.zh.md#preinstalled-plugins)预装原版第三方 bundle，不恢复自研实现。不迁移配对、不删除已保存凭据，也不修改插件偏好。已有会话和工作区仍由原有服务管理。

## Alternatives considered

- **保留两套实现。** 这仍需维护两条手机访问路径以及自研协议和客户端，违背用户不再维护自研方案的选择。
- **为自研配套应用增加外网支持。** 这扩大了同一维护职责，而不是使用用户已能工作的插件。

## Consequences

Hemi 放弃内置的按设备配对和撤销界面，以及固定 TLS 证书的 iOS 配套应用。每个选用插件的远程访问安全和兼容性需单独审查；移除 Hemi 服务不代表第三方插件已通过安全验证。重新引入自研实现需要明确证明，受支持的第三方方案无法满足新的实际需求。

## Testing

Desktop 启动场景断言已移除的 Loader 条目和手机设置区域不存在。Connection 与 Gateway 回归覆盖保留的 Web 路由。生成目录和文档检查拒绝陈旧包引用；浏览器验证记录不含配套应用入口的设置导航。
