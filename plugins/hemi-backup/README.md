---
description: "Install Hemi data backup into a dsh profile as an independent config-only layer: pack the three tgz archives from a checkout, add them through the profile plugin command, and stay clear of compositions that already wire the backup rows."
kind: "package-bundle"
---

# @hemi/backup

English | [中文](README.zh.md)

## Summary

`@hemi/backup` is the config-only profile layer for installing Hemi data backup: `cordis.patch.yml` inserts the backup rows and the package itself owns no code. Pack it together with the two backup packages into three tgz archives and add all three to a profile through `dsh plugin --profile <name> add`. Backup behavior — dual-root snapshot archives, local or WebDAV targets, scheduled runs with retention, and staged merge restore — belongs to those packages.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

Pack and install from a checkout of this repository that has completed a workspace build, so the two backup packages carry the `lib/` outputs that `pack.mjs` verifies.

```text
pnpm install && pnpm run build
node plugins/hemi-backup/pack.mjs <destination>
```

`pack.mjs` packs `@deepseek-ai/dsh-hemi-backup`, `@deepseek-ai/dsh-hemi-backup-ui`, and `@hemi/backup` into `<destination>` (default `dist/`) and writes `packages.json` there with each archive's file name, version, and SHA-256.

Add all three archives in one profile plugin command — the normal entry point, which forwards its arguments verbatim to pnpm inside the profile directory:

```text
dsh plugin --profile <name> add \
  <destination>/deepseek-ai-dsh-hemi-backup-<version>.tgz \
  <destination>/deepseek-ai-dsh-hemi-backup-ui-<version>.tgz \
  <destination>/hemi-backup-<version>.tgz
```

Read the exact file names from `<destination>/packages.json`. `@hemi/backup` declares the two backup packages as peer dependencies at matching versions; one command adding all three archives satisfies them.

Install this layer only on compositions that carry no built-in Hemi backup rows: the web-app bundle in this checkout already wires `hemi-backup` and `hemi-backup-ui`, and adding this layer on top inserts those rows again. Profiles composed from official upstream bundles carry no such rows.

### Verify the installation

The real-profile installation smoke drives the whole path on a clean official composition — install, host start, the settings section, a local-target backup, a merge restore, and a restart:

```text
node plugins/hemi-backup/tests/installed-smoke.mjs
```

Set `HEMI_BACKUP_BROWSER_CHANNEL=chrome` to reuse a system Chrome when the bundled Playwright browser is absent.

<a id="understand-the-implementation"></a>
## Understand the implementation

`cordis.patch.yml` inserts two rows: `hemi-backup` (the host service owning the `hemiBackup` Remote namespace) and `hemi-backup-ui` (the browser settings section). The package's `dsh.bundle.patch` declaration is what the profile plugin manager reads after installation, so the rows land in the profile composition without editing `cordis.yml`.

<a id="further-exploration"></a>
## Further Exploration

- `packages/hemi/backup` — the snapshot engine, WebDAV client, and orchestrator service.
- `packages/hemi/backup-ui` — the settings section over the `hemiBackup` namespace.
- `plugins/hemi-model-routing` — the sibling installable layer for Hemi model routing.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The smoke installs with pnpm against the registry; a fully offline installation needs a warmed store.
- WebDAV targets are exercised by unit-level contracts only; the smoke drives a local-folder target.
