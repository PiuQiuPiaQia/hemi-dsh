---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-hemi-summary-retry-messages

[English](2026-11-09-hemi-summary-retry-messages.md) | 中文

## 概述

确认 Hemi 记忆摘要请求引用的共享 RequestMessage 类型新增上游重试消息变体。摘要写入器与 Session 格式版本保持不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-hemi-summary-retry-messages
baseline: false
changes:
  - root: "event:hemi-memory/summary-request"
    previous: "2026-11-05-hemi-memory-lifecycle"
    after: "504cf77b5065e0c691edc2eab270520e98808463ed46d94c18fbbb5c75aecd79"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有摘要记录仍然有效。共享声明现在允许 source kind 为 retry 的持久化用户消息，但记忆写入器仍只生成不带 source、正文为普通文本的 RequestUserInput 值，因此旧读取器收到的摘要请求字段和值保持原样。Hemi 摘要消费方不会把已记录的 messages 重新作为会话输入执行；未声明 Hemi 事件的读取器通过 ignorable: true 保留并跳过这些事件。已有摘要记录不需要新的解释方式，因此 Session 格式版本保持不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/api/session-controller/tests/commands-upload-file.host.spec.ts packages/hemi/routing/tests/model-visible.spec.ts packages/hemi/memory/tests/lifecycle.spec.ts：49 项测试通过。记忆生命周期用例检查准确的不带 source 的摘要请求、ignorable 标记，以及缺少 Hemi 事件声明时的已发布 V4 恢复。

<a id="dev-note"></a>
## 开发备注

无。
