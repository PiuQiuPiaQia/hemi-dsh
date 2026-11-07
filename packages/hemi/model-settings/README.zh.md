---
description: "Hemi 模型设置页的宿主连接测试。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-model-settings

[English](README.md) | 中文

## 概述

Profile 所有者可使用已保存的供应商配置和凭据测试型号。服务发送一次简短请求并报告是否收到预期的工具调用。测试不会执行工具，也不会写入会话历史。 本服务也拥有提供方中立的 Desktop 引导偏好。

## 目录

- [桌面设置](#desktop-setup)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="desktop-setup"></a>

## 桌面设置

当 `desktopStartup: true` 时，本插件还注册会被记录的系统提示身份 `You are an AI agent powered by Hemi.`，所属组合停用原生 harness 身份。卸载插件会移除其提示段。

`desktopStartup` 默认为 `false`，Hemi Desktop 组合将其设为 `true`。此时 `desktopStartup()` 返回工作区启动方式与保存的语言，不请求账号或凭据。`desktopWelcome()` 提供本地引导进度；已有的引导完成记录或保存的型号选择也视为已完成。`completeDesktopWelcome()` 通过所有者设置服务保存初始为 `false` 的 `welcomeCompleted`。共享访问方不能完成设置。这些操作不请求模型。

## 模型体验

<a id="model-experience"></a>

### 显式连接测试

#### 模型看到的内容

测试通过保存的路由发送合成提示词与工具 schema，不包含对话历史；检查响应但不执行工具。

#### Token 影响

Each explicit test uses a `128`-token output limit and may be billed by the provider.

#### KV Cache 影响

测试是独立请求，不修改任何对话前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 测试使用已保存的供应商配置。一次响应未返回工具调用时，无法据此判断模型是否具备工具调用能力。

### 开发备注

<a id="dev-note"></a>

无。
