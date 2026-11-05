---
description: "供桌面壳导入的 Hemi Electron 专用适配。"
kind: "package-library"
---

# @deepseek-ai/dsh-hemi-customizations

[English](README.md) | 中文

## 概述

本包集中管理 Electron 主进程与沙箱 preload 需要的非插件 Hemi 适配。功能服务仍由各自的 Hemi 插件提供。桌面壳从本包导入主进程适配，从 `/preload` 导入浏览器安全桥接。

主进程适配创建独立的 New API 登录窗，并注册桌面壳传入的 IPC 通道。每个操作先执行桌面壳的发送方授权检查。桌面壳在关闭已认证 Host 前等待导入任务清理。Preload 入口不导入 Electron 主进程代码。

## 目录

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

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
