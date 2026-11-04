---
description: "Snapshot backup for the Harness home and shared skills: local or WebDAV archives, retention pruning, and staged merge restore."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-backup

English | [中文](README.zh.md)

## Summary

`dsh-hemi-backup` is the host-side Hemi backup orchestrator. It snapshots the two user-data roots — the Harness home (`~/.dsh`: credentials, sessions, storages, memory, profile manifests) and the shared agent root (`~/.agents/skills`) — into a chunked ustar+gzip archive with a sha256-verified manifest, writes it to a local folder or a WebDAV target (Nutstore), prunes old sets under a retention count, and restores by staging a set, previewing a per-file merge estimate, then merging: new files land, identical files skip, conflicts keep the newer side and displace the loser into a safe-copy folder. Skill directories whose collected size exceeds the configured threshold (default 5 MB) are skipped whole and recorded in the manifest's `skipped` list.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Client interface](#client-interface)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The package is wired into the web-app bundle as the root-scope `hemi-backup` entry; no per-profile configuration is required. The one tunable is the skill size threshold:

```yaml
# cordis.patch.yml overlay
- id: hemi-backup
  name: '@deepseek-ai/dsh-hemi-backup'
  config:
    skillMaxBytes: 5242880
```

Backup targets, schedule, and retention are user settings owned by the service (persisted at `~/.dsh/backup-settings.json`) and edited through the `dsh-hemi-backup-ui` settings section, not through cordis.yml.

<a id="understand-the-implementation"></a>
## Understand the implementation

- `src/engine.ts` — collection whitelist (dual-root, prefix-labeled `dsh/` and `agents/` archive paths), streaming ustar+gzip packer with per-volume sha256 and GNU long-name support, incremental extractor, and the per-file restore authority (`decideRestoreAction`) shared by merge and preview. Snapshot defense cuts appended growth to the collected size and fails when a file rewrites shorter mid-pack; symlinked paths are never followed in either direction.
- `src/webdav.ts` — the WebDAV operations the orchestrator needs (MKCOL/PUT/PROPFIND/DELETE/GET) over `fetch`, with typed `AUTH_FAILED` / `NOT_FOUND` / `REQUEST_FAILED` failures.
- `src/service.ts` — the `hemiBackup` Remote namespace: `getState`, `saveSettings`, `testConnection`, `runNow`, `listBackups`, `deleteSet`, `restorePrepare`, `restoreApply`, `restoreCancel`. The WebDAV application password is stored through the credential service (`HEMI_BACKUP_WEBDAV_PASSWORD`), never in the settings file; an hourly tick decides whether the schedule is due.

<a id="client-interface"></a>
## Client interface

`./client` exports the client-safe view types (`BackupStateView`, `BackupSetView`, `RestorePreview`, operation results); `./remote` carries the generated Typert client face used by `dsh-hemi-backup-ui`.

<a id="known-limitations-and-deferred-work"></a>
## Known limitations and deferred work

- The archive is not encrypted; credentials ship inside it, so a cloud target holds a plaintext equivalent. The settings section states this.
- Restore completes only after an app restart; profile composition manifests are restored but their `node_modules` are reinstalled by the plugin manager.
- There is no idle gate yet: scheduled runs rely on the packer's snapshot defense while a session writes.
