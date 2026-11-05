---
description: "Hemi 记忆工具和设置服务共用的 Markdown 存储。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-memory

[English](README.md) | 中文

## 概述

在智能体 preset 挂载此包以启用记忆工具。在 Host 根作用域挂载 `@deepseek-ai/dsh-hemi-memory/settings` 以服务[「记忆」页](../memory-ui/README.zh.md)。两者共用 `$DSH_HOME/hemi-memory/` 中的文件。

## Automatic memory

主智能体在每个待执行步骤读取长期记忆、便签和当天日志。上下文压缩成功后，将交接摘要和便签写入每日日志。运行实例关闭时，等待最近使用的模型生成辅助摘要。恢复后的运行实例只总结本次运行中的新用户对话。空运行实例、子智能体和插件重配置跳过退出摘要。

| Field | Default | Effect |
|---|---|---|
| contextMaxBytes | 16384 | 注入记忆的 UTF-8 字节上限 |
| summaryMaxInputBytes | 49152 | 摘要指令和对话文本的 UTF-8 字节上限 |
| summaryMaxOutputTokens | 1024 | 辅助模型的输出 token 上限 |
| summaryTimeoutMs | 3500 | 摘要准备和请求的毫秒时限 |

请求和结果记录为 `hemi-memory/summary-request` 和 `hemi-memory/summary-result`。结果包含提供方返回的用量。超时、输出不完整或存储失败时会记录警告。保存成功的摘要显示在每日日志。Hemi 用量面板按模型计入摘要已返回的用量。

## 目录

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

远程请求与响应字段由 [`src/remote.ts`](src/remote.ts) 定义。

## 模型体验

<a id="model-experience"></a>

### 记忆工具调用

#### 模型看到的内容

Preset 注册 `memory_write`、`memory_read`、`memory_search` 和 `memory_forget`。模型调用读取或搜索工具时会收到保存的文本。

#### Token 影响

工具定义占用请求 token，返回的记忆文本增加调用会话的 token。

#### KV Cache 影响

同一 preset 的工具定义保持稳定。工具结果追加到会话历史。编辑文件不会改写已经返回的结果。

### 自动上下文与退出摘要

#### 模型看到的内容

`hemi:memory` 运行上下文包含有长度限制的记忆 Markdown。独立的退出请求让最近使用的模型保留决定、经验、未完成事项和后续工作。发送前会记录完整的辅助请求。

#### Token 影响

记忆上下文增加输入 token。退出摘要是独立的有长度限制的请求，使用自己的输出额度。

#### KV Cache 影响

记忆发生变化时，在下一次请求替换相应运行上下文。辅助摘要使用独立输入，生成的结果改变后续请求中的日志上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 记忆文件保存在当前 Harness home。设置页保存时在与工具共用的写锁内核对版本。外部编辑器不参与这把锁。

正常进程关闭另有整体时限，强制终止可能中断摘要。切换对话页面不会结束仍驻留的运行实例。Hemi 摘要事件携带可忽略标记，缺少插件的读取方可以保留并跳过这些记录。

### 开发备注

<a id="dev-note"></a>

无。
