---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-hemi-memory-lifecycle

English | [中文](2026-11-05-hemi-memory-lifecycle.zh.md)

## Summary

Adds Hemi memory summary request and result events to record auxiliary model input, outcomes, and reported usage.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing logs remain valid. New Hemi summary events carry ignorable: true and do not change the model-visible conversation surface. Readers without Hemi declarations retain and skip them under the released-v4 unknown-ignorable-event contract. The additive Session.append option only exposes the existing envelope marker for non-surface events. No existing event discriminator changes its interpretation, so the Session format version stays unchanged.

<a id="verification"></a>
## Verification

The real Cordis Loader and AgentLoop tests verify context updates, awaited close summaries, whole-root teardown with persisted result records, failed summaries, blank runtimes, real compaction handoffs, reconfiguration, subagents, restored idle history, and timeouts.

<a id="dev-note"></a>
## Dev Note

None.
