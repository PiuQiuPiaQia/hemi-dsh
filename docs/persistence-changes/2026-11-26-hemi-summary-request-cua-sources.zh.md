---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-26-hemi-summary-request-cua-sources

[English](2026-11-26-hemi-summary-request-cua-sources.md) | 中文

## 概述

只读的遗留记忆事件声明跟随合并上游 DSH 0.2.3-alpha.2 带来的 Message 来源变更。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-26-hemi-summary-request-cua-sources
baseline: false
changes:
  - root: "event:hemi-memory/summary-request"
    previous: "2026-11-18-hemi-summary-request-message-drift"
    after: "331ec833f4a644928b1a88bad52e1f67e792757a9e391e5efe1b6570dc772a67"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

自研记忆工具移除后没有任何写入方产生 hemi-memory/summary-request；该声明只为旧会话可读而保留。该变更仅通过 data.messages 共享的 Message 类型波及此事件：上游新增了 cua-activity、cua-held-inputs 和 cua-inputs-released 来源种类以及 system-prompt 的可选 complete、reset、sections 字段，并替换了一个 user 角色消息变体。已存储的记录保留录制时的变体。会话恢复只校验 surface 事件的事件数据，用量投影通过非严格 schema 只读取 config.provider 与 config.model，因此新旧记录都不会经 data.messages 解释。该事件中不会出现新变体，Session 格式版本保持不变。

<a id="verification"></a>
## 验证

node_modules/.bin/vitest run packages/hemi/routing/tests/usage.spec.ts：11 个测试通过。以合并前清单运行 persistence-review，event:hemi-memory/summary-request.data.messages[] 下仅列出新增的来源种类、system-prompt 可选字段和 user 角色变体替换。

<a id="dev-note"></a>
## 开发备注

无。
