---
kind: upgrade-guide
description: "Hemi desktop packages adopt independent application names, protocol registration and default data directories."
---

# Hemi desktop identity

English | [中文](guide.zh.md)

## Change

Hemi GitHub desktop builds use the Hemi display name, `Hemi.app` or `Hemi.exe`, monochrome wave-H artwork, `hemi-dsh-<version>-<platform>-<arch>` installers, and the `hemi-dsh://open` external protocol. Their Electron preferences retain the platform application-data directory's `hemi-dsh` child; their default Harness home remains `~/.hemi-dsh`. Existing files remain in place; no account, Session or preference migration runs automatically.

The bundle identifier `ai.hemi.dsh.desktop`, fixed signing certificate, repository and update-feed URLs remain the same. Internal DSH packages and the `dsh` engine command retain their names. Unbranded DSH builds retain their defaults.

The Desktop profile hides upstream feedback and log-upload controls and disables `/feedback`, feedback capture and Session-log exporters. DeepSeek model connections and local Session export remain available. New model requests identify the product as Hemi; saved Session history is unchanged.

## Migration

1. Quit the previous desktop application and install the newly named Hemi application manually once, so the installed bundle filename also changes. Check any existing `Hemi.app` before replacing it.
2. Start the new application and confirm Hemi in About. Existing `hemi-dsh` preferences and `~/.hemi-dsh` Sessions remain available.
3. If you deliberately want a previous Harness data root, provide its absolute path through the existing `DSH_HOME` environment override before launch. Check which application owns that directory first. This override selects Harness files and does not migrate Electron preferences.
4. Keep the previous data directories until the new installation has been verified. Subsequent updates use the existing nightly or stable feed with the new artifact names.
