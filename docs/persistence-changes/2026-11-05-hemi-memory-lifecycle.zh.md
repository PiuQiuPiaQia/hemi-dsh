---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-05-hemi-memory-lifecycle

[English](2026-11-05-hemi-memory-lifecycle.md) | 中文

## 概述

新增 Hemi 记忆摘要请求和结果事件，记录辅助模型输入、结果及提供方返回的用量。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-hemi-memory-lifecycle
baseline: false
changes:
  - root: "event:hemi-memory/summary-request"
    previous: null
    after: "abaad7d9f1223d2bc721eae95294e2fb1350084992963e061849731639c2413d"
    decision: same-version
  - root: "event:hemi-memory/summary-result"
    previous: null
    after: "7469de89cec22acde46f43a5afe6591821af34f5a545532e92c8372178013ae0"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有日志保持有效。Hemi 摘要事件携带 ignorable: true，不改变模型可见的对话内容。缺少 Hemi 声明的读取方按已发布 v4 的未知可忽略事件规则保留并跳过这些记录。新增 Session.append 可选参数只为非 surface 事件开放已有的信封标记。已有事件判别值的解释保持一致，因此 Session 格式版本保持不变。

<a id="verification"></a>
## 验证

真实 Cordis Loader 和 AgentLoop 测试验证每轮上下文更新、等待关闭摘要、整应用释放后的结果落盘、摘要失败、空运行实例、真实压缩交接、重配置、子智能体、无新消息的恢复会话和超时。

<a id="dev-note"></a>
## 开发备注

无。
