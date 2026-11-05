---
kind: upgrade-guide
description: "Custom Hemi memory compositions now require model, prompt, and Session persistence services."
---

# Hemi automatic memory

English | [中文](guide.zh.md)

## Change

Hemi main conversations load saved memory and produce automatic compaction handoffs and runtime-close summaries. Summary calls add `hemi-memory/summary-request` and `hemi-memory/summary-result` to their Session logs. These informational records carry the ignorable marker, so older readers retain and skip them. The memory tool plugin now requires the LLM, system-prompt, and Session persistence services.

## Migration

1. Keep existing memory Markdown files in place. The plugin continues to use the current Harness home.
2. Custom compositions mounting `@deepseek-ai/dsh-hemi-memory` must also provide `llm`, `systemPrompt`, and `sessionPersistence`. The shipped web composition already provides them.
3. Open Settings → Memory to review saved Markdown. After ending a main runtime, check its daily log for a summary or the application log for an unsuccessful summary warning. Hemi usage panels include reported summary usage by model.
