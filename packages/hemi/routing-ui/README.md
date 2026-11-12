---
description: "Configure Hemi main and role models from the conversation model menu or Models settings; documents automatic routing controls, saved selections, and current UI boundaries."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-routing-ui

English | [中文](README.zh.md)

The Hemi composer picker, its styles and alternative-selection state belong to `src/client/model-picker/`. Configure the native model-selection plugin with `showComposer: false`; this plugin owns the composer and child slots while reusing native model directories and the `model` dictionary. Do not mount two composer owners in the same composition. The picker and usage popovers share the [native picker's CSS Anchor Positioning requirements and layout-viewport zoom behavior](../../client/ui-model-selection/README.md#understand-the-implementation).

## Summary

Choose a main model and models for the Research, Review, Execution, and Design roles from the configured model catalog. Enable or disable automatic routing separately for each ordinary conversation. The model menu and Settings → Models open the same editor; each choice saves automatically and accepted values return through the settings mirror. Existing requests are unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Hemi uses the [custom model picker](src/client/model-picker/ModelSelect.tsx) with provider groups and plugin controls in one menu. When the routing plugin is installed, Automatic routing appears first as an alternative to a concrete model. In fixed mode, supported models show a separate reasoning-effort selector to the right of the model button; it saves through the native model-selection service. Explicitly non-reasoning models omit that selector. Automatic routing shows Low, Medium, High and Maximum in the same position, saves the choice per conversation, and maps it to the main and role models on later turns without exiting automatic routing. Opening keeps focus on the trigger. Tab enters search or the current option, arrow keys browse rows, and Escape returns to the trigger.

Open the conversation's model menu and choose the gear beside Automatic routing, or open Settings → Models → Configure model routing. Choose the main model before enabling automatic routing. A role set to Follow main model uses the configured main model; users cannot create roles or enter arbitrary provider/model ids.

Explicit choices also refresh the defaults for new conversations, including reselecting the current model, mode, or effort. Merely opening an existing conversation does not refresh those defaults; the Host owns [capture and persistence](../routing/README.md#use-this-package). Model choices save individually. Loading, read-only settings, failed writes, failed provider catalogs, and unavailable configured models remain visible. An unavailable saved model retains its provider, model, and reasoning effort until explicitly replaced. Changing another field does not remove it. Main and role configuration changes apply to later turns. Selecting a concrete model exits automatic routing and takes effect at the next step.

Mount this plain UI plugin alongside the routing Host plugin and the standard model selection, settings, locale, and layout providers. It declares no bundle and does not alter the shipped Web composition. It mounts its own generated routing Remote contribution, then activates controls while that namespace and the catalog are available; a missing settings namespace is reported inside the editor. The editor adds no independent settings tab or page chrome.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin supplies the first radio choice through `conversation.input.model.alternative` and contributes to `conversation.input.model.options`, `conversation.input.model.label`, `settings.models.footer`, and `shell.overlay`. The model-menu owner dismisses its menu and restores trigger focus before the gear opens the shared modal. Child Sessions inherit the root Session's routing mode. The plugin's `sessionModes` settings map is the mode source of truth. The controls subscribe only to their conversation's saved preference through the shared settings mirror; a refused enable/disable operation reports through the model menu's failure surface without an optimistic mode change.

The editor reads `hemi-routing-settings` through ConfigForms. Each mutation carries the exact revision read for that choice. Role edits preserve the other current routes and replace the role map atomically; concurrent or stale writes are refused rather than overwriting another accepted change. The editor serializes its own writes and retains failure feedback across closing and reopening. The catalog is refreshed on entry and can be retried after a failure.

The plugin removes its controls before unmounting its Remote contribution, and rolls back the contribution if control registration fails.

Source ownership: [registration](src/client/mount.ts), [editor operations](src/client/editor-state.ts), [configuration form](src/client/RoutingSection.tsx), [mode control](src/client/RoutingModeToggle.tsx), and [inline labels](src/client/RoutingModelLabel.tsx). Package tests exercise the real primitives and slot registry; they do not replace a composed application smoke.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Model selection](../../client/ui-model-selection/README.md) — model-menu ownership and label placement.
- [Settings](../../client/ui-settings/README.md) — shared configuration mirror and revision-fenced writes.
- [UI primitives](../../client/ui-primitives/README.md) — modal, menu, button, switch, and badge behavior.

-----

<a id="model-experience"></a>
## Model Experience

### Routing selections

#### What the model sees

This UI adds no prompt text or tool. It submits saved main/role choices and the Session-scoped `hemiRoutingSettings.setEnabled` command; the routing Host plugin saves the preference in its settings and owns the effect on subsequent model requests, without adding custom Session events.

#### Token effect

The controls and configuration copy consume no model-context tokens. The Host plugin owns any routing instructions.

#### KV Cache effect

The UI does not change prompt prefixes. Selecting another model can change provider-side cache reuse for later requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The current UI stays within the existing model-menu extension slots.

- On an older DSH client, the menu uses the legacy routing switch. Use that switch to pin the current model.
- Mode preferences belong to the current profile. Exporting or forking Session history does not copy them.
- In Hemi, the selected mode supplies the trigger caption, accessible name, and tooltip. Model rows keep their catalog names and badges.
- Only the four preset roles are editable. The editor has no fallback-model or cross-model retry controls and no free-form reasoning-effort input; reselecting an unchanged model preserves its saved effort.
- The main model has no clear action: its picker lists catalog models only, so it is replaced rather than removed, and roles return to following it through their own Follow main model choice.
- Package component previews and tests do not verify real provider execution, the final distribution wiring, or the composed application's session replay.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`pnpm exec vite --config packages/hemi/routing-ui/tests/preview/vite.config.ts` serves the real components over inert data for theme and width checks; it connects to no Host and proves no Remote flow.

</details>

The turn usage panel shows the current agent and historical direct synchronous role calls, retaining their custom-tool receipts. The custom composer component in `src/client/usage/SessionUsage.tsx` reads Hemi’s `hemiModelUsage` projection and recursively follows native child catalogs. It groups recorded calls by provider/model across the conversation tree, showing model (provider), call count, total input, output, cache hit rate and cache reads/writes. Provider labels use the current shared model catalog's connection names, including names from failed provider catalogs; unknown historical providers retain their recorded IDs. Renaming a connection updates its label without changing recorded usage or merging distinct connections. Totals and cache rates use available counters; missing usage or counters contribute zero for display only, without changing recorded reports. A zero input total shows a 0% cache rate. Calls without usage remain counted. The footer and detail rows show the cache rate without report-coverage counts or notices. The collapsed indicator shows the reported cache hit rate, weighted by input tokens across the conversation tree; background children refresh it while the panel is closed. Fork-inherited calls are excluded, retries are counted, and recorded compaction/memory summaries are included. It preserves provider totals even without a cache breakdown. Opening and refreshing retain the last successful tree result; a failed refresh keeps it visible with an automatic-retry notice. Solo conversations use their live projection without another read. Read failures and inaccessible branches remain visible; opening the panel never resumes agents or calls a model. The detail panel refreshes while open and supports narrow screens. Redundant uncached-input subrows, per-model totals and provider subrows are omitted.
