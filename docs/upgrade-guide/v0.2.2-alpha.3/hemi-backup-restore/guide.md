---
kind: upgrade-guide
description: "Hemi backup restore preserves existing Session directories instead of replacing their generations by modification time."
---

# Hemi backup preserves existing sessions

English | [中文](guide.zh.md)

## Change

Backup controls are now under Settings → Backup, with an independent navigation entry instead of a card under General.

Hemi backup previously resolved Session file conflicts by modification time. Restore now keeps every file in an existing Session directory unchanged and saves differing or additional backup generations separately. Missing Session directories still restore; ordinary data keeps the newer-file merge policy. Invalid manifests and archive paths are rejected before restoration.

Backup now includes `$DSH_HOME/hemi-memory/`. Older archives remain readable but may lack the long-term memory, daily logs, and working notes that earlier backups omitted.

## Migration

1. Make a fresh backup through Settings → Backup before transferring data to another machine. Old archives cannot recover files they never collected.
2. Restore and review the preview. Existing sessions keep their local histories; inspect conflicting backup generations under `$DSH_HOME/restore-safety/restore-*/dsh/sessions/`. Do not copy them over an active or committed Session generation.
3. Restart the application and confirm the missing sessions and Hemi memory are present. If restore fails, retain the original archive and the safe-copy directory reported by the operation; the merge may be partial.
