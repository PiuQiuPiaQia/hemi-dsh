---
description: "Settings section for Hemi data backup: target editing, connection test, manual and scheduled runs, the backup-set list, and the staged restore dialog."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-backup-ui

English | [中文](README.zh.md)

## Summary

`dsh-hemi-backup-ui` registers an independent Backup page in the settings navigation: last-run status, target editing (local folder or WebDAV/Nutstore with an application password), a connection test, manual backup, the schedule and retention controls, the backup-set list with per-set restore and delete, and the staged restore dialog showing the merge preview (new / identical / conflicts) before applying. All actions call the `hemiBackup` Remote namespace owned by `dsh-hemi-backup`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The package is wired into the web-app bundle as the browser `hemi-backup-ui` entry; it requires `dsh-hemi-backup` on the host side and no configuration of its own.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/client/index.ts` registers the `hemi-backup` locale namespace and injects `BackupSection` into the `settings.section` slot; the injected face unwraps Remote result envelopes around the host methods. The restore dialog explains that existing sessions stay unchanged and conflicting session backups are saved separately. `BackupSection.tsx` owns the editor state, a single-flight busy guard, progress polling while a run executes, and cancels any staged restore when the section unmounts.

## Model Experience

### `Backup` controls

#### What the model sees

`hemiBackup` settings and restore previews stay in the user interface.

#### Token effect

The panel sends no model requests.

#### KV Cache effect

The panel does not alter request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- There is no first-run restore wizard; restore always starts from the settings page.
- The local-folder target is a typed path; no native directory picker on desktop yet.

### Dev Note

None.
