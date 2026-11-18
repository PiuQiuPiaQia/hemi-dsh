---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-hemi-summary-request-message-drift

[English](2026-11-18-hemi-summary-request-message-drift.md) | 中文

## 概述

只读的历史记忆事件声明跟随 rc.4 上游 Message 联合类型的漂移。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-hemi-summary-request-message-drift
baseline: false
changes:
  - root: "event:hemi-memory/summary-request"
    previous: "2026-11-09-hemi-summary-retry-messages"
    after: "57f665519277d1ccb7a17e70e3904efce0f5d5ff0fb3b98c24e2e1275284e0b7"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

自研记忆工具移除后没有任何写入方产生 hemi-memory/summary-request；该声明只为旧会话可读而保留。历史记录携带早期消息变体，用量投影不改写地读取它们，因此该事件中不会出现新变体。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/hemi/routing/tests/usage.spec.ts：11 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
