---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-hemi-summary-request-message-drift

English | [中文](2026-11-18-hemi-summary-request-message-drift.zh.md)

## Summary

The read-only legacy memory event declaration follows the rc.4 upstream Message union drift.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

No writer produces hemi-memory/summary-request since the self-built memory tools were removed; the declaration exists so old sessions stay readable. Historical records carry the earlier message variants and the usage projection reads them without rewriting, so no reader can meet the new variants in this event.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/hemi/routing/tests/usage.spec.ts: 11 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
