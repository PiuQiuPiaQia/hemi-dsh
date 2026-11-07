---
description: "Hemi 模型与路由设置页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-model-settings-ui

[English](README.md) | 中文

## 概述

桌面配置新增独立的「模型接入」设置入口，包含 Hemi 的订阅、New API、API Key 接入方式，以及路由和每个已接入模型旁的测试按钮。DSH 原模型页保留，可通过独立的设置导航入口打开。

## 目录

- [桌面引导](#desktop-introduction)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="desktop-introduction"></a>

## 桌面引导

Desktop 引导复用已有的 `settings.onboarding` 协调器与共享弹窗的键盘和焦点管理。整页展示沿用原生 Desktop Welcome 的布局、字体和纵向排列的 240×44 按钮，不显示悬浮卡片。提供模型接入或进入工作区两个入口，不包含登录、充值或提供方选型。完成标记在导航前保存；保存失败时保留引导并允许重试。Hemi 自有页面打开 `hemi-model-access`，桌面壳不依赖该设置页标识。

## 模型体验

<a id="model-experience"></a>

### 连接测试

#### 模型看到的内容

The page delegates explicit model tests to the `model-settings` Host service and route editing to the routing settings service.

#### Token 影响

编辑不消耗 token；显式测试消耗被测试提供方的 token。

#### KV Cache 影响

页面不添加请求前缀；选择不同模型可能改变缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- New API 浏览器登录需要桌面桥接。订阅授权和额度由 model-access Host 插件提供。

### 开发备注

<a id="dev-note"></a>

无。
