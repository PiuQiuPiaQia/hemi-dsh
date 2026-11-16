---
kind: upgrade-guide
description: "Hemi 移除内置手机配对服务、设置页和 iOS 配套应用源码。"
---

# Hemi 移除内置手机连接

[English](guide.md) | 中文

## 变更

Hemi 不再包含内置手机连接设置、TLS 监听器、配对 API 或 iOS 配套应用源码。`@deepseek-ai/dsh-hemi-mobile-access` 和 `@deepseek-ai/dsh-hemi-mobile-access-ui` 两个包已移除。此前配对的 Hemi 手机应用无法再通过这项服务连接。

已有会话、工作区、凭据和第三方插件配置保持不变。第三方手机客户端使用各自的连接与认证设置；Hemi 的配对不会迁移到这些客户端。

## 迁移

1. 如果自定义 profile 补丁引用了任一已移除包，或指定了 `hemi-mobile-access`、`hemi-mobile-access-ui` 条目 ID，在启动升级后的应用前删除对应条目。
2. 停止使用 Hemi iOS 配套应用。Hemi Desktop 已预装原版 [dsh-pocket](https://github.com/shaobeichen/dsh-pocket) 插件，需要手机访问时按其说明配置配对和网络。已有插件偏好保持不变，不导入 Hemi 原有配对。
3. 重启 Hemi，确认内置手机连接设置已消失，已有会话仍可打开。第三方连接需单独验证；远程智能体访问能修改文件和执行命令，请仅批准可信设备。
