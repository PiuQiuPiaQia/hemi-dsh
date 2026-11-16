---
kind: upgrade-guide
description: "Hemi 移除自研记忆工具、设置编辑器和摘要；Desktop 预装原版 dsh-mnemon 插件。"
---

# 移除 Hemi 自研记忆功能

[English](guide.md) | 中文

## 变更

Hemi 移除 `@deepseek-ai/dsh-hemi-memory` 和 `@deepseek-ai/dsh-hemi-memory-ui`。原「记忆」设置编辑器、`memory_write`、`memory_read`、`memory_search`、`memory_forget`、已保存记忆上下文、压缩交接和运行实例关闭摘要不再由 Hemi 提供。Desktop 预装原版 [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) 插件，由它提供自己的工具与设置；已有的停用状态保持不变。

`$DSH_HOME/hemi-memory/` 下的已有文件保持不变，仍在 Hemi 备份范围内。Hemi 用量面板继续读取历史摘要用量，已有 Session 日志不重写。

## 迁移

1. 如仍需要已有内容，保留 `$DSH_HOME/hemi-memory/MEMORY.md`、`daily/` 和 `SCRATCHPAD.md`。功能移除不会删除、导入或自动加载这些文件。
2. 从自定义组合中移除旧记忆包的条目、依赖和覆盖配置。移除的条目 id 为 `hemi-memory`、`hemi-memory-settings` 和 `hemi-memory-ui`；残留覆盖可能产生目标未匹配警告。
3. 打开新会话，确认四个旧记忆工具和 `hemi:memory` 上下文不再出现。Hemi 记忆编辑器已移除，新记忆操作使用预装的 Mnemon 插件。已有第三方配置保留，旧 Hemi 记忆文件不会自动导入。
