---
description: "Hemi Electron adapters and independent GitHub Desktop release tooling."
kind: "package-library"
---

# @deepseek-ai/dsh-hemi-customizations

English | [中文](README.zh.md)

## Summary

This package owns non-plugin Hemi adapters required by the Electron main process and sandboxed preload. Feature services remain in their Hemi plugins. The desktop shell imports the main adapter from this package and the browser-safe bridge from `/preload`.

The main adapter embeds the isolated New API sign-in view in the product window and registers the shell-provided IPC channel. Every operation runs the shell's sender authorization first. The shell disposes import work before shutting down the authenticated Host. The preload entry imports no Electron main-process code.

## Table of Contents

- [Startup presentation](#startup-presentation)
- [Preinstalled plugins](#preinstalled-plugins)
- [GitHub releases](#github-releases)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="startup-presentation"></a>

## Startup presentation

The `/desktop-branding` adapter names the application Hemi while retaining the `hemi-dsh` distribution marker, external protocol, artifact prefix and preference directory. `/desktop-artwork` owns monochrome distribution resources; `/web-branding` applies them to explicitly named Hemi Web builds. Regenerate the resources with `node packages/hemi/customizations/release/render-artwork.mjs` from the repository root. This workspace-only renderer is excluded from published runtime files; the generated distribution resources remain included.

The `/desktop-branding` adapter supplies localized boot presentation and reads the Hemi Host plugin’s provider-neutral startup contribution. The Desktop Host bundles this entry into its executable module at build time. Loading retains the native layout and light/dark palette, with Hemi branding and status copy. It does not replace the native account Welcome: Hemi Desktop bypasses that window and hosts its introduction in the Hemi settings plugin.

<a id="preinstalled-plugins"></a>

## Preinstalled plugins

The pure-Node `/desktop-plugins` adapter selects the original `dsh-pocket` and `dsh-mnemon` bundles once for Desktop profiles whose CLI installation declares both packages. It records `hemiDesktop.preinstalledBundles` in the same atomic manifest write as the selection, under the Desktop profile lock. Already selected bundles are not duplicated; profile-installed but deselected copies remain off. User patches, dependency versions, lockfiles and plugin data are not rewritten. Subsequent launches and recovery do not re-enable bundles the user switched off.

The CLI manifest pins the shipped versions. Other profiles carry the packages but do not select their bundles automatically. Plugin Manager uses its existing installation ownership: bundled packages can be switched off or on, cannot be uninstalled from the signed runtime, and update with Hemi. Pocket keeps its original LAN/password behavior and saved tunnel preferences; a fresh installation starts no public tunnel. Mnemon keeps its own tools, settings and storage; no Hemi memory or phone pairing data is imported.

Runtime preparation uses `stageHemiDesktopPluginSources` to verify and copy the [Pocket source and license](../../../apps/cli/third-party/dsh-pocket/README.md) before recording runtime integrity. A source digest or installed-version mismatch stops packaging. The adapter does not execute the archive or download plugin code at application startup.

<a id="github-releases"></a>

## GitHub releases

The `/github-distribution`, `/github-release` and `/github-release-command` build-time entries enable independent GitHub Desktop distribution. The community signing, runner setup and Computer Use adapters use `/github-community-signing`, `/github-community-setup` and `/github-community-cua`. See [GitHub release configuration and recovery](release/README.md). These entries do not load Electron or change the client updater. `configureHemiDesktopIdentity` applies the explicit packaged `hemi-dsh` marker before Electron preferences are read; `/desktop-branding` owns shared product names.

## Model Experience

### Desktop account operations

#### What the model sees

The `newApiImport` bridge adds no prompt text or tools. Model validation and account operations belong to [model-access](../model-access/README.md).

#### Token effect

The adapters issue no model request and consume no tokens.

#### KV Cache effect

The adapters do not change model request prefixes or existing conversation history.

## Known Limitations and Deferred Work

- The main entry requires Electron and cannot run in a headless DSH Host. It is imported by the desktop application rather than mounted as a Cordis plugin. Build and package it with the same fork version as the shell and model-access plugin. Upstream integration points are tracked in the [fork ledger](../../../hemi-fork-changes.md#hemi-customization-isolation).

### Dev Note

None.
