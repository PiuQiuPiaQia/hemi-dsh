---
kind: upgrade-guide
description: "Hemi 记忆自定义组合现在需要模型、提示词和 Session 持久化服务。"
---

# Hemi 自动记忆

[English](guide.md) | 中文

## 变更

Hemi 主会话自动载入记忆，并在上下文压缩和运行实例关闭时生成交接信息与摘要。摘要调用向 Session 日志添加 `hemi-memory/summary-request` 和 `hemi-memory/summary-result`。这些信息记录携带可忽略标记，旧读取方会保留并跳过它们。记忆工具插件现在依赖 LLM、系统提示词和 Session 持久化服务。

## 迁移

1. 将已有记忆 Markdown 文件保留在原处。插件继续使用当前 Harness home。
2. 挂载 `@deepseek-ai/dsh-hemi-memory` 的自定义组合需要提供 `llm`、`systemPrompt` 和 `sessionPersistence`。产品 Web 组合已经提供这些服务。
3. 在设置 → 记忆查看已保存的 Markdown。主运行实例结束后，查看每日日志中的摘要，或应用日志中的摘要未成功警告。Hemi 用量面板按模型计入摘要已返回的用量。
