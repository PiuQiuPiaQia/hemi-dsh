---
kind: upgrade-guide
description: "Hemi removes its self-owned memory tools, settings editor and summaries; Desktop preinstalls the original dsh-mnemon plugin."
---

# Hemi built-in memory is removed

English | [中文](guide.zh.md)

## Change

Hemi removes `@deepseek-ai/dsh-hemi-memory` and `@deepseek-ai/dsh-hemi-memory-ui`. The old Memory settings editor, `memory_write`, `memory_read`, `memory_search`, `memory_forget`, saved-memory context, compaction handoffs and runtime-close summaries are no longer provided by Hemi. Desktop preinstalls the original [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) plugin with its own tools and settings; existing disabled installations remain disabled.

Existing files under `$DSH_HOME/hemi-memory/` remain untouched and remain included in Hemi backups. Historical summary usage remains readable in Hemi's usage panel. Existing Session logs are not rewritten.

## Migration

1. Retain `$DSH_HOME/hemi-memory/MEMORY.md`, `daily/` and `SCRATCHPAD.md` if you still need their contents. Removing the feature does not delete, import or automatically load these files.
2. Remove the old memory package entries, dependencies and overrides from custom compositions. The removed entry ids are `hemi-memory`, `hemi-memory-settings` and `hemi-memory-ui`; stale overrides can produce unmatched-target warnings.
3. Open a new conversation and confirm that the four old memory tools and `hemi:memory` context are absent. The Hemi Memory editor is removed; use the preinstalled Mnemon plugin for new memory operations. Existing third-party configuration is preserved, and old Hemi memory files are not imported automatically.
