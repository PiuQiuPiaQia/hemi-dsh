---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-session-execution-target

English | [中文](2026-11-09-session-execution-target.zh.md)

## Summary

Records an optional immutable execution target in Session metadata, independently of the cwd and Agent preset.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing headers without executionTarget retain the deployment's default execution behavior. Current readers preserve the provider and target id through JSONL encoding, header-only queries, cold reads and forks. Earlier V4 logical and physical header readers reject the additional field, so V4 remains safe without an additional event or a format bump. The runtime refuses unavailable explicit targets before fresh writer publication or semantic crash repair; it never drops the reference to run locally. Accepted historical schemas and format checkpoints are unchanged.

<a id="verification"></a>
## Verification

117 focused Session, V4 codec and JSONL tests passed, plus 53 Agent create/resume tests. A plain-Node process using the real pre-change built JSONL reader rejected both a complete targeted artifact and a header-only targeted artifact; all artifact bytes remained unchanged, and an untargeted local artifact opened and read successfully. Both plaintext and Zstandard cold-read tests retain the reference. Invalid targets with recoverable torn tails refuse read/write-open without changing bytes; corresponding valid-target controls remain readable.

<a id="dev-note"></a>
## Dev Note

None.
