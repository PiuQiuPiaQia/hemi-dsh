---
description: "Hemi character skin themes as alias-token palettes; for maintainers porting the Hemi skin table."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-hemi-skins

English | [中文](README.zh.md)

## Summary

Register the six Hemi desktop-assistant skins (classic plus the five character skins) as selectable alias-token themes, apply the chosen skin through a durable `overrideTokens` layer, and render the ported character artwork as a backdrop without lettering. Artwork keeps its intrinsic aspect ratio and uses Hemi's height-based framing: 104% height, -12% right, -13% bottom; at widths up to 880px, 90% height, -40% right, -8% bottom. The built-in theme preference schema accepts only light/dark/system, so a third-party `setTheme` call is reverted by the next settings adopt; the override layer keeps the skin live across preference changes. Idle animations and portraits are deferred.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further exploration](#further-exploration)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)
- [Dev note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The web-app bundle mounts this plugin after `dsh-client-ui-theme`, so `ctx.theme` is available. Every `ThemeDefinition` id is a valid `setTheme` argument for downstream pickers. The skin settings section shows six equal-width presets below its heading and uses fewer columns in narrow panels. A check marks the active skin; selection applies immediately and is saved per browser. Classic is the default black-and-white skin, with no character backdrop; it follows the native light/dark palette. Valid saved selections take precedence, while absent or unavailable selections use Classic.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/client/skins.ts` keeps Classic on the native neutral palette and maps the five Hemi character palettes from `skins.config.json` (rail, accent, scale-600, line) into a small `--dsw-alias-*` token set. The client half registers each skin and disposes the registrations on teardown.

The backdrop layer is a full-viewport body child mounted after `#root` and is visual only. Its sheet opts it out of app-region collection with `-webkit-app-region: initial !important`: the shell's darwin `body > :not(#root)` rule subtracts body-level overlays from the window drag surface by DOM order, and a full-viewport no-drag box would otherwise disable titlebar dragging and its native double-click maximize/restore on macOS.

The plugin occupies the sidebar name and mark, conversation hero mark and running-status mark slots at priority -10. The sidebar shows Hemi with a smaller, secondary-text `dsh` suffix on the same text baseline and suppresses its logo; the collapsed rail retains the native expand icon. The hero keeps the transparent wave-H mask in the theme’s neutral text color. The running-status slot renders no artwork, suppressing the native whale tail without changing the status text or clock. Skin palettes and backdrops remain independent of the monochrome artwork. Removing the plugin restores the original occupants.

<a id="further-exploration"></a>
## Further exploration

- `packages/client/ui-theme` owns the theme registry, token stylesheets, and settings rows.
- The Hemi source table lives in the Hemi repository at `src/shared/appearance/skins.config.json`.

## Model Experience

### Skin selection

#### What the model sees

`overrideTokens` colors and artwork stay in the browser and add no model input.

#### Token effect

Skin changes send no model requests.

#### KV Cache effect

Skin changes preserve model request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Portraits, idle animation, and lettering are not rendered.

<a id="dev-note"></a>
### Dev Note

Fork addition; keep the palette table in sync with the Hemi source of truth.
