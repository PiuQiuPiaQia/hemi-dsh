---
kind: upgrade-guide
description: "Hemi's routing roles are reserved for child Agents when creating new main sessions."
---

# Hemi routing roles in main sessions

English | [中文](guide.zh.md)

## Change

Earlier Hemi profiles offered `explorer`, `oracle`, `fixer`, and `designer` as main-session presets. Hemi now reserves them for subagent delegation. The main-session menu and default settings omit them. An existing default pointing to one of these roles resolves to the deployment default, normally `standard`. Historical sessions can still use their recorded composition.

## Migration

1. If a client sends one of these IDs as `session.create.agentPreset`, select a main-session preset such as `standard`. Set a custom deployment's `agent-preset-registry.config.default` to a main-session preset as well.
2. Open the Agent presets settings and confirm the active default. In standard mode, delegation still accepts the four role IDs as `agent_preset`.
