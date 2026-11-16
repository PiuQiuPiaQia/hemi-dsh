---
kind: upgrade-guide
description: "Hemi Desktop supplies dsh-pocket and dsh-mnemon as release-owned bundles instead of requiring profile installation."
---

# Hemi Desktop preinstalls third-party plugins

English | [中文](guide.zh.md)

## Change

Hemi Desktop carries the original `dsh-pocket` and `dsh-mnemon` packages. The first preparation of a new or upgraded profile selects their bundle layers once, unless a profile dependency already records an installed but deselected package. Later launches and recovery do not re-enable bundles the user switched off.

The installation's pinned package takes precedence over a profile-local copy. Bundled files cannot be uninstalled or replaced through profile package management; their versions update with Hemi. Existing profile dependencies, plugin configuration and data are retained. No old Hemi memory or phone pairing data is imported, and a fresh installation starts no public tunnel.

## Migration

1. Quit Hemi before upgrading. No plugin installation command is needed. If an upstream bundle's `insert` block was manually copied into a custom patch, remove that copied block to avoid duplicate entry IDs; retain ordinary `- id:` overrides.
2. Open Plugins and confirm that `dsh-pocket` and `dsh-mnemon` are listed. Existing disabled installations remain off; use each bundle's switch to choose its state. Disable a bundle rather than trying to uninstall its signed runtime files.
3. Configure phone access or memory through the original plugins. Hemi retains their existing preferences and credentials; public access remains a separate user action. Pocket's original GPL-2.0 license and matching complete source are included in the [source distribution](../../../../apps/cli/third-party/dsh-pocket/README.md).
