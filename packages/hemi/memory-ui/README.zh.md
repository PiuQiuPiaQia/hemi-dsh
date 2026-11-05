---
description: "用于编辑 Hemi 跨会话记忆的独立设置页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-memory-ui

[English](README.md) | 中文

## 概述

打开 **设置 → 记忆** 可编辑长期记忆、指定日期的日志和便签。点击保存会写入文件。如果打开后文件发生变化，页面会保留草稿并提示重新加载。Web App bundle 挂载此客户端插件和 [Host 设置服务](../memory/README.zh.md)。

自动记忆行为由 [Host 插件](../memory/README.zh.md#automatic-memory)负责。页面说明自动载入、压缩交接和退出摘要，并提示辅助摘要用量按模型记录。

## 目录

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## 模型体验

<a id="model-experience"></a>

### 保存编辑

#### 模型看到的内容

设置页不添加提示词。后续 `memory_read` 或 `memory_search` 调用可返回保存后的内容。

#### Token 影响

保存操作不消耗请求 token。后续工具结果按返回的文本计入。

#### KV Cache 影响

保存保留以往请求和工具结果。后续工具调用追加自己的结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 按日期打开每日日志。未保存的文本保留在当前编辑器中，关闭编辑器时丢弃。

### 开发备注

<a id="dev-note"></a>

无。
