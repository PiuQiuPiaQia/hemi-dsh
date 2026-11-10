---
description: "Keep SSH connections in Hemi’s Workspace picker and open verified remote directories as real Workspaces."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-ssh-servers-ui

English | [中文](README.zh.md)

## Summary

Save SSH connections and choose them repeatedly from the conversation’s Workspace picker. Select a connection, then browse and open a real remote directory. The sidebar lists directory Workspaces and their Sessions, not saved servers. Saving connection details does not start SSH or change the selected Workspace.

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

Choose **Add SSH** below **Add workspace** in the conversation’s Workspace picker or sidebar add menu. The form accepts a display name, one SSH address, a separate port, an optional private-key path and an optional preferred remote directory. The address accepts username@host or an OpenSSH alias. A private key stays on the Hemi host; the field accepts its path, not its contents.

The editor retains the optional preferred-directory field. **Choose directory** opens the same directory picker used by saved connections, against the staged endpoint. Select a physical directory to fill the field; leaving it blank starts in the remote home.

Selecting a saved connection opens a directory picker at its preferred directory or remote home. The picker separates the server identity, location bar, location shortcuts, scrollable folder area and confirmation actions. Click folder rows to navigate, use the home or preferred-location shortcuts, or enter an absolute path in the location bar. Up to three visited locations are available for the same endpoint during this UI lifetime. **Use this folder** admits and selects a real Workspace only after the displayed location has been read successfully; loading, failed reads and unsubmitted path edits cannot select an old result. One connection can open several directories.

The Workspace dropdown, selected Workspace chip and sidebar use the backend’s [SSH display names](../ssh-servers/README.md#use-this-package), including Workspaces registered before the current UI mounted. Same-named directories on one connection also show distinguishing path suffixes in the dropdown and sidebar. Long names remain available through full-name tooltips and hover details; on hoverless screens, opening the dropdown or expanding a remote Workspace reveals its full label. Local Workspace names stay unchanged.

SSH sign-in appears only when OpenSSH requests a response. For eligible target-host password prompts, **Remember password** is optional and starts unchecked for every new prompt, including retries after a saved password is rejected. The Host saves the password only after SSH authentication succeeds, in the local DSH credentials file as plain text with mode 0600 (current-user read/write), not the system keychain. Key passphrases, one-time codes, other non-password responses and cancellations are never saved. If password storage fails after sign-in, the Host closes that connection; reconnect without remembering or check DSH credential-store access.

Right-click keeps the clicked connection visible behind the standard Workspace-style actions. The context-menu key and Shift+F10 work on a focused row. Escape dismisses that action popup before the underlying picker. Deletion still requires confirmation and leaves Workspaces and remote files intact.

If a saved connection change completes but password cleanup fails, the list refreshes and the dialog keeps a warning with repeat submission disabled. Restart Hemi to retry cleanup, then close and refresh the list.

Mount this UI plugin with `dsh-hemi-ssh-servers`, its `/workspaces` entry and the standard Workspace, locale, resources, Remote access, context-menu and layout providers. Hemi Desktop composes these entries; other profiles opt in. No execution-environment fields are exposed. Directory reads connect over SSH without installing files; opening a Workspace asks the Host to prepare its bundled execution files. SSH configuration files and local directory picking remain unchanged; first-host trust requires explicit confirmation. See the backend’s [requirements](../ssh-servers/README.md#use-this-package).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client combines the SSH address only in its transient draft; Host storage keeps host, username and the optional preferred directory. Lists and both editor and saved-directory reads use resources. A changed draft endpoint invalidates its old browser; a failed read retains prior data but prevents its selection. Only a successful `prepareServerFolder` result reaches ordinary Workspace admission. The original picker receives its returned Workspace id, never a connection or target id. Host permissions, endpoint revisions and physical-directory validation remain authoritative.

One registered root-scoped interaction store shares editor requests, drafts, notices and recently visited locations across menu and overlay entries; location history is isolated by host, login, port and identity-file path and is not persisted. Authoritative lists, directory results and authentication challenges remain in the resource model. Login responses stay in the keyed prompt form until dispatch and are cleared on submission or disconnection; they never enter the shared store, resource values or saved connection records. The remember choice applies only to its submission; the Host owns successful-password storage. Gateway supervises the challenge stream; connection recovery and the next directory request reopen its resource. Closing remote reads aborts them and suppresses late navigation. A Workspace write already dispatched may commit after dismissal, so the notice asks the user to check the list. Unloading withdraws contributions and settles dispatched work before unmounting Remote. Saved Host records remain.

Source ownership: [registration](src/client/mount.ts), [connection requests](src/client/controller.ts), [folder requests](src/client/folder-controller.ts), [interaction store](src/client/store.ts), [connection picker](src/client/ConnectionPicker.tsx), [folder dialog](src/client/FolderOverlay.tsx) and [login prompts](src/client/AuthenticationOverlay.tsx).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspaces](../../client/ui-workspace/README.md) — sidebar ownership and native directory picking.
- [Client resources](../../../docs/subsystems/client-resources.md) — shared resource reads and lifetime.
- [Web Client Slots](../../../docs/subsystems/slots.md) — composition and shared interaction stores.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes no tools, prompts, Session events or model-visible content.

#### KV Cache effect

None; this package does not assemble model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Remote selection has these limits:

- Saving a connection does not resolve SSH aliases or check whether hosts and key paths exist.
- Other windows’ changes become visible when the connection list is refreshed, after a local successful write, on connection recovery or when its resource reopens; there is no Host change feed.
- Both endpoints must support POSIX. Non-remembered sign-in responses are transient; closing the app, losing its SSH connection or rejection of a remembered password may require signing in again. Remote execution requirements are owned by the backend.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
