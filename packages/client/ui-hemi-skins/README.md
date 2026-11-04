---
description: "Hemi character skin themes as alias-token palettes; for maintainers porting the Hemi skin table."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-hemi-skins

English | [中文](README.zh.md)

## Summary

Register the six Hemi desktop-assistant skins (classic plus the five character skins) as selectable alias-token themes, apply the chosen skin through a durable `overrideTokens` layer, and render the ported character artwork as a fixed backdrop without lettering. Artwork keeps its intrinsic aspect ratio and uses Hemi's height-based framing: 104% height, -12% right, -13% bottom; at widths up to 880px, 90% height, -40% right, -8% bottom. The built-in theme preference schema accepts only light/dark/system, so a third-party `setTheme` call is reverted by the next settings adopt; the override layer keeps the skin live across preference changes. Idle animations and portraits are deferred.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)
- [Dev note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The web-app bundle mounts this plugin after `dsh-client-ui-theme`, so `ctx.theme` is available. Every `ThemeDefinition` id is a valid `setTheme` argument for downstream pickers.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/client/skins.ts` mirrors the Hemi `skins.config.json` palette table (rail, accent, scale-600, line) into a small `--dsw-alias-*` token set. The client half registers each skin and disposes the registrations on teardown.

<a id="further-exploration"></a>
## Further exploration

- `packages/client/ui-theme` owns the theme registry, token stylesheets, and settings rows.
- The Hemi source table lives in the Hemi repository at `src/shared/appearance/skins.config.json`.

<a id="known-limitations-and-deferred-work"></a>
## Known limitations and deferred work

Startup application overwrites the persisted preference until a skin picker row ships. Background images, portraits, idle animation, and lettering are deferred.

<a id="dev-note"></a>
## Dev note

Fork addition; keep the palette table in sync with the Hemi source of truth.
