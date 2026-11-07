---
kind: upgrade-guide
description: "创建主会话时，Hemi 路由角色仅供子智能体使用。"
---

# 主会话中的 Hemi 路由角色

[English](guide.md) | 中文

## 变更

旧版 Hemi profile 提供 `explorer`、`oracle`、`fixer` 和 `designer` 作为主会话预设。现在这四个角色仅供子智能体委派使用，主会话模式菜单和默认模式设置均不再显示它们。如果已保存的默认值指向其中一个角色，新会话会使用部署默认值，通常为 `standard`。历史会话仍可使用记录的预设。

## 迁移

1. 如果客户端在 `session.create.agentPreset` 中传入这些 ID，改用 `standard` 等主会话预设。自定义部署的 `agent-preset-registry.config.default` 也应设置为主会话预设。
2. 打开 Agent 预设设置，确认当前默认模式。标准模式的委派仍接受四个角色 ID 作为 `agent_preset`。
