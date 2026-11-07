---
description: "Hemi Electron 适配与独立的 GitHub Desktop 发布工具。"
kind: "package-library"
---

# @deepseek-ai/dsh-hemi-customizations

[English](README.md) | 中文

## 概述

本包集中管理 Electron 主进程与沙箱 preload 需要的非插件 Hemi 适配。功能服务仍由各自的 Hemi 插件提供。桌面壳从本包导入主进程适配，从 `/preload` 导入浏览器安全桥接。

主进程适配将隔离的 New API 登录视图嵌入应用主窗口，并注册桌面壳传入的 IPC 通道。每个操作先执行桌面壳的发送方授权检查。桌面壳在关闭已认证 Host 前等待导入任务清理。Preload 入口不导入 Electron 主进程代码。

## 目录

- [启动页展示](#startup-presentation)
- [GitHub 发布](#github-releases)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="startup-presentation"></a>

## 启动页展示

`/desktop-branding` 适配使用 Hemi 应用名称，保留 `hemi-dsh` 分发标记、外部协议、安装包前缀和偏好目录。`/desktop-artwork` 拥有黑白分发资源，`/web-branding` 将其应用到显式命名的 Hemi Web 构建。在仓库根目录运行 `node packages/hemi/customizations/release/render-artwork.mjs` 可重新生成资源。

`/desktop-branding` 适配提供本地化加载展示，并读取 Hemi Host 插件的提供方中立启动选项。Desktop Host 在构建时将此入口打包进启动模块。加载页保留原生布局和浅深色配色，仅使用 Hemi 品牌与状态文案。它不替换原生账号欢迎页：Hemi Desktop 跳过该窗口，将引导放在 Hemi 设置插件中。

<a id="github-releases"></a>

## GitHub 发布

构建时入口 `/github-distribution`、`/github-release` 和 `/github-release-command` 提供独立的 GitHub Desktop 分发。社区签名、runner 配置和 Computer Use 适配分别由 `/github-community-signing`、`/github-community-setup` 和 `/github-community-cua` 提供。参见 [GitHub 发布配置与恢复](release/README.zh.md)。这些入口不加载 Electron，也不改变客户端更新器。`configureHemiDesktopIdentity` 在读取 Electron 偏好设置前应用显式的打包 `hemi-dsh` 标记，`/desktop-branding` 拥有共享产品名称。

## 模型体验

<a id="model-experience"></a>

### 桌面账号操作

#### 模型看到的内容

`newApiImport` 桥接不添加提示词或工具。型号验证和账号操作由 [model-access](../model-access/README.zh.md) 提供。

#### Token 影响

适配本身不发送模型请求，也不消耗 token。

#### KV Cache 影响

适配不改变模型请求前缀或已有对话历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 主入口依赖 Electron，不能在无界面的 DSH Host 中运行。桌面应用直接导入本包，不把它挂载为 Cordis 插件。它与桌面壳、model-access 插件使用同一 fork 版本构建和打包。上游接线位置见[改动账本](../../../hemi-fork-changes.md#hemi-customization-isolation)。

### 开发备注

<a id="dev-note"></a>

无。
