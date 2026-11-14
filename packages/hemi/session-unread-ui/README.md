---
description: "Mark conversations unread from their context menu without changing selection."
kind: "package-reference"
---
# @deepseek-ai/dsh-hemi-session-unread-ui

English | [中文](README.zh.md)

## Summary

Choose **Mark as unread** from a Session's right-click or More menu to leave a reminder without switching conversations. The next visit clears the reminder. Marking the open conversation preserves it until you leave and return.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The Hemi Web composition mounts this browser plugin. Its menu action appears after Fork session for unarchived Sessions. There are no configuration fields. A reminder uses the existing status dot with the label **Unread**; running work and pending interactions keep their existing priority.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [Hemi subsystem](../../../docs/subsystems/hemi.md) locates this plugin within the product. The plugin contributes through the shared [context menu registry](../../client/ui-context-menu/README.md). The [Session UI adapter](../../client/ui-session/README.md) owns reminder state; the plugin does not retain Sessions, send Host requests, or modify their logs. Contributions leave with the plugin's Cordis fiber.

</details>

<a id="model-experience"></a>
## Model Experience

None, as this plugin changes browser viewing state and registers nothing model-facing.

#### KV Cache effect

None; the menu action does not assemble model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Reminders are local to the current browser runtime and do not survive reloads or synchronize across windows.

<a id="dev-note"></a>
### Dev Note

None.
