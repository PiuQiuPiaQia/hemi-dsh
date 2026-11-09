---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-hemi-summary-retry-messages

English | [中文](2026-11-09-hemi-summary-retry-messages.zh.md)

## Summary

Acknowledges the upstream retry-message variant in the shared RequestMessage type referenced by Hemi memory summary requests. The summary writer and Session format version remain unchanged.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing summary records remain valid. The shared declaration now permits durable user messages whose source kind is retry, but the memory writer still emits source-free RequestUserInput values with ordinary text content. Older readers therefore receive the same summary request fields and values. Hemi summary consumers do not replay the recorded messages as conversation input, and readers without Hemi declarations retain and skip these events through ignorable: true. No new interpretation of an existing summary record is required, so the Session format version remains unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/api/session-controller/tests/commands-upload-file.host.spec.ts packages/hemi/routing/tests/model-visible.spec.ts packages/hemi/memory/tests/lifecycle.spec.ts: 49 tests passed. The memory lifecycle case checks the exact source-free summary request, its ignorable marker, and released-V4 restoration without Hemi event declarations.

<a id="dev-note"></a>
## Dev Note

None.
