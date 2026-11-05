---
description: "Snapshot backup for the Harness home and shared skills: local or WebDAV archives, retention pruning, and staged merge restore."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-backup

English | [中文](README.zh.md)

## Summary

Back up the Harness home and shared agent skills to local folders or WebDAV with volume hashes and retention controls. Preview restores before merging: new files are added, identical files are skipped, existing sessions retain their local generations, and ordinary conflicts retain the newer copy while preserving the other in a safe-copy folder. Oversized skill directories are skipped and listed in the manifest.

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

Restore never replaces, renames, or deletes a file in an existing Session directory, and never adds another generation there. Identical backup files are skipped; differing or additional backup generations are saved under `restore-safety/restore-*/dsh/sessions/`. Missing Session directories are restored with exclusive file publication, so a competing writer's file cannot be overwritten. Other data retains the per-file merge policy. A failed merge can be partial; keep the original backup and the reported safe-copy directory before retrying.

The collection includes `$DSH_HOME/hemi-memory/` (`MEMORY.md`, `daily/`, and `SCRATCHPAD.md`) and the legacy `memory/` directory. Existing archives remain readable, but archives made before Hemi memory was collected cannot restore omitted files. Make a fresh backup before moving machines.

Manifest fields and volume basenames are validated before local reads or WebDAV downloads. Extracted names, including GNU long names, must be relative paths within the collection whitelist; traversal, absolute paths, Windows aliases, links, duplicate files, and incomplete tar streams are rejected. Source-read, compression, or output failures reject the backup and remove its partial set; failed packing never uploads or prunes older sets.

<a id="client-interface"></a>
## Client interface

`./client` exports the client-safe view types (`BackupStateView`, `BackupSetView`, `RestorePreview`, operation results); `./remote` carries the generated Typert client face used by `dsh-hemi-backup-ui`.

## Model Experience

### Backup and restore

#### What the model sees

Archive operations register no model input or tools. Restored `Session` files retain their recorded contents.

#### Token effect

Archive operations consume no model tokens.

#### KV Cache effect

Backup preserves request prefixes; restoring a different Session history can change subsequent requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The archive is not encrypted; credentials ship inside it, so a cloud target holds a plaintext equivalent. The settings section states this.
- Restore completes only after an app restart; profile composition manifests are restored but their `node_modules` are reinstalled by the plugin manager.
- There is no idle gate yet: scheduled runs rely on the packer's snapshot defense while a session writes.

### Dev Note

None.
