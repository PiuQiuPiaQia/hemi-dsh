---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-26-hemi-summary-request-cua-sources

English | [中文](2026-11-26-hemi-summary-request-cua-sources.zh.md)

## Summary

The read-only legacy memory event declaration follows the upstream Message source changes merged with DSH 0.2.3-alpha.2.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

No writer produces hemi-memory/summary-request since the self-built memory tools were removed; the declaration exists so old sessions stay readable. The change reaches this event only through the Message type shared by data.messages: upstream added the cua-activity, cua-held-inputs and cua-inputs-released source kinds and the optional system-prompt complete, reset and sections fields, and replaced one user-role message variant. Stored records keep the variants they were recorded with. Session restore validates event data only for surface events, and the usage projection reads only config.provider and config.model through a non-strict schema, so neither older nor newer records are interpreted through data.messages. No reader can meet the new variants in this event, so the Session format version remains unchanged.

<a id="verification"></a>
## Verification

node_modules/.bin/vitest run packages/hemi/routing/tests/usage.spec.ts: 11 tests passed. persistence-review against the pre-merge inventory lists, under event:hemi-memory/summary-request.data.messages[], only the added source kinds, the optional system-prompt fields and the user-role variant replacement.

<a id="dev-note"></a>
## Dev Note

None.
