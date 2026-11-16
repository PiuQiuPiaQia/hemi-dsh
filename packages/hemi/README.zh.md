---
description: "Hemi 插件与 Electron 适配的代码归属和上游接线规则。"
kind: "package-group"
---

# Hemi fork 代码

[English](README.md) | 中文

## Summary

Hemi 功能插件放在本目录。非插件的桌面壳适配放在 [customizations](customizations/README.zh.md)。皮肤插件保留在 [client/ui-hemi-skins](../client/ui-hemi-skins/README.zh.md)，独立安装组合层放在 [plugins](../../plugins/)。

[Hemi 二开约束](../../docs/defensive-patterns/hemi-fork.zh.md) 统一规定实现位置、原生行为保留、上游注释和验证要求。[改动账本](../../hemi-fork-changes.md#hemi-customization-isolation) 记录保留的修改和上游合并核对项。

原生运行时行为继续由[模型流式调用](../../docs/subsystems/llm-streaming.zh.md)与[子智能体](../../docs/subsystems/subagent.zh.md)文档说明。

[Hemi 子系统](../../docs/subsystems/hemi.zh.md)记录插件的服务接口。
