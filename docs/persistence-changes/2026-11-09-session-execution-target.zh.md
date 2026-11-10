---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-session-execution-target

[English](2026-11-09-session-execution-target.md) | 中文

## 概述

在 Session 元数据中记录可选且不可变的执行目标，独立于 cwd 和 Agent preset。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-session-execution-target
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-11-initial"
    after: "1fe1256ec59a2231aa92888824a2c61c8554c1a55b5b8fb709428a62daf6f5b8"
    decision: same-version
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "eeb6349d6cbab77802fc238c14bdf63c0d9f00844826f3caa96f6eb25fd2d744"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

不含 executionTarget 的已有 header 保留部署的默认执行行为。当前读取器在 JSONL 编码、header-only 查询、冷读取和 fork 中保留 provider 与目标 id。较早 V4 的逻辑及物理 header 读取器均拒绝新增字段，因此无需额外事件或格式升级即可保持 V4 的安全性。运行时在发布新 writer 或执行语义崩溃修复前拒绝不可用的显式目标，绝不丢弃引用转为本地运行。已接受的历史 schema 和格式 checkpoint 保持不变。

<a id="verification"></a>
## 验证

117 项 Session、V4 codec 与 JSONL 定向测试通过，另有 53 项 Agent 创建及恢复测试通过。使用真实改动前已构建 JSONL 读取器的 plain-Node 进程分别拒绝了完整和仅 header 的带目标文件；全部文件字节保持不变，未指定目标的本地文件仍可正常打开及读取。明文和 Zstandard 冷读取测试均保留该引用。含非法目标与可恢复坏尾的文件均拒绝 read/write-open 且不改字节，对应有效目标负控仍可读取。

<a id="dev-note"></a>
## 开发备注

无。
