---
description: "Hemi 独立的「模型接入」设置页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-model-access-ui

[English](README.md) | 中文

## 概述

桌面配置加载 Hemi 的「模型接入」页面，提供订阅账号、New API 导入和 API Key 接入。订阅账号在额度可用时显示周限和五小时剩余额度。每个型号提供紧凑的设置、测试和删除图标，附有本地化的无障碍名称和提示。拉取型号使用带搜索的弹窗，确认勾选后才添加。API 接入和订阅模型均可覆盖显示名称、token 限额及文本／图片输入能力。删除最后一个型号仍保留连接和凭据。

## 目录

- [使用本包](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## 使用本包

<a id="use-this-package"></a>

Key 预设只提供连接地址，不预填模型 ID。保存连接前，需要从接口读取或手动输入型号。拉取弹窗每次打开都重新读取服务端，并提供「刷新」操作。刷新失败时清空候选列表并显示错误与重试入口，不删除已保存的型号。New API 导入后的连接使用同一设置编辑器。

模型设置可编辑显示名称、上下文长度、最大输出 token 及文本／图片输入类型。可选字段留空、输入类型选择继承时使用适配器默认值。新连接的模型草稿随连接保存；已有型号的设置单独确认保存。取消对应弹窗不修改设置。

## 模型体验

<a id="model-experience"></a>

### 连接编辑

#### 模型看到的内容

The editor submits account operations to the `model-access` Host plugin, which owns import validation requests.

#### Token 影响

单纯编辑不发送模型请求；显式验证导入可能消耗提供方 token。

#### KV Cache 影响

编辑器不添加对话前缀；选择导入模型可能改变提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 浏览器登录需要桌面壳。没有桌面桥接时，可以使用已有令牌导入表单。

### 开发备注

<a id="dev-note"></a>

无。
