---
kind: upgrade-guide
description: "Hemi desktop packages adopt independent application names, protocol registration and default data directories."
---

# Hemi desktop identity

English | [中文](guide.zh.md)

## Change

Hemi GitHub desktop builds use `hemi-dsh.app` or `hemi-dsh.exe`, `hemi-dsh-<version>-<platform>-<arch>` installers, and the `hemi-dsh://open` external protocol. Their Electron preferences use the platform application-data directory's `hemi-dsh` child; their default Harness home is `~/.hemi-dsh`. The first test release used DeepSeek Harness names and the shared `~/.dsh` default. Existing files remain in place; no account, Session or preference migration runs automatically.

The bundle identifier `ai.hemi.dsh.desktop`, fixed signing certificate, repository and update-feed URLs remain the same. Internal DSH packages and the `dsh` engine command retain their names. Unbranded DSH builds retain their defaults.

## Migration

1. Quit the previous Hemi test application and install the newly named `hemi-dsh` application manually once, so the installed bundle filename also changes.
2. Start the new application and confirm its name in About. A fresh default profile uses `~/.hemi-dsh`; set up accounts and device preferences there as needed.
3. If you deliberately want a previous Harness data root, provide its absolute path through the existing `DSH_HOME` environment override before launch. Check which application owns that directory first. This override selects Harness files and does not migrate Electron preferences.
4. Keep the previous data directories until the new installation has been verified. Subsequent updates use the existing nightly or stable feed with the new artifact names.
