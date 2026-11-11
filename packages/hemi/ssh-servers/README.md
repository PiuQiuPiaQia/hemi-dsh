---
description: "Save SSH connections, browse remote directories and prepare execution runtimes for remote Workspaces."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-ssh-servers

English | [中文](README.zh.md)

## Summary

Save named SSH servers and keep their host, port, login name and private-key path references across restarts. Editors must supply the record's revision before changing or removing it, so stale edits cannot overwrite a newer record. Saving a server does not connect to it, install software, read a private key or change a local Workspace. The separate `workspaces` entry validates real remote directories and registers immutable execution targets for ordinary Workspace creation.

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

Hemi Desktop composes this service with the [SSH server UI](../ssh-servers-ui/README.md). Other profiles leave it disabled. The saved-server entry has no configuration fields and requires the [domain storage service](../../storage/storage-domain/README.md) with a configured backend.

Names and hosts must be nonblank; the port is an integer from 1 through 65535. Empty login names and private-key paths use OpenSSH configuration. Saved records contain no passwords or private-key contents. An optional absolute remote `directory` is only the preferred starting location; one connection may open several Workspaces. Saving references does not verify SSH access.

Mount `@deepseek-ai/dsh-hemi-ssh-servers/workspaces` with the Session store and sandbox policy. Both endpoints must support POSIX OpenSSH. Native OpenSSH askpass challenges handle passwords, key passphrases and explicit first-host trust; changed host keys fail closed. Responses never enter logs or connection records.

An eligible saved connection’s target-host password prompt offers **Remember password**, unchecked by default. A chosen password is stored only after authentication succeeds, through the optional [credential provider](../../credentials/credentials-local/README.md); the default provider writes plaintext to `$DSH_HOME/.credentials.yaml` with owner-only permissions. Reuse requires the exact host, login, port, identity-file path and native login name. A rejected saved password returns to manual entry rather than being submitted repeatedly. A subsequent authentication prompt cancels a newly requested password save; multi-factor challenges remain manual. Other prompts, including private-key passphrases, one-time codes and jump-host prompts, remain transient. Renaming retains the password; changing the endpoint or removing its last saved connection clears it. A password-write failure closes the new connection and reports an unconfirmed save; a cleanup failure reports that the server change is durable and retries cleanup at service restart.

The Host instance retains a foreground authenticated master for each exact host, login, port and identity-file combination and reuses it for directory reads and execution channels. See [authentication semantics](../../../docs/subsystems/hemi.md#ssh-authentication) for challenge ownership and cancellation.

The `/workspaces` entry accepts these settings; each is an integer from 1 through 2147483647. They do not change saved connections or SSH configuration files.

| Setting | Default | Effect |
|---|---|---|
| `authenticationTimeoutMs` | 120000 | Bounds connection setup, all prompts and readiness in milliseconds. |
| `serverAliveIntervalSeconds` | 10 | Seconds between OpenSSH liveness probes for the retained master. |
| `serverAliveCountMax` | 3 | Unanswered probes before OpenSSH disconnects; a later operation can authenticate again. |
| `runtimeProvisionTimeoutMs` | 300000 | Milliseconds allowed for the whole remote Node provisioning operation, including platform probing, download, upload and verification. |

`browseServer` and `browseSavedFolders` use the authenticated SSH connection without a remote runtime or remote writes; an empty path resolves the remote home. Cancelled login starts no requested directory or execution operation. Accepted first-host trust may remain in OpenSSH’s known-host file.

`prepareServerFolder` verifies the captured endpoint, prepares the bundled versioned execution files in an application-owned remote cache, and validates the selected physical directory before returning a durable execution reference. The helper runs on a Node runtime Hemi provisions itself: the pinned official Node.js build is checksum-verified on this computer, uploaded into the same cache and reused across connections, and an existing remote Node.js 24 or newer on the server is used instead when present. Servers need no preinstalled Node; Linux servers need glibc 2.28 or newer, and older-glibc or musl systems are warned about but not refused. Nothing outside this cache is written and SSH configuration is unchanged. The deployment must stay outside the writable Workspace. Pass the returned path and execution reference to `workspace.create`, never a synthetic Workspace id. Editing or deleting a connection does not rewrite existing target snapshots. `configureRuntime` and revision-bound deployment operations also support explicitly installed deployments.

When a saved Workspace or Session resumes, a target backed by an older Hemi-managed artifact set uses the bundled helper from the current installation. The deployment cache is content-addressed and the saved execution reference still identifies the original server and physical directory.

When the Workspace Controller is composed, its read-only display projection labels existing and new SSH Workspaces as `folder（connection name）`; custom Workspace titles retain their text and receive the same connection suffix once. The explicit execution reference selects the immutable target snapshot, never a matching local path. A saved connection with the same id, host, login, port and identity-file path supplies its current name, so pure renames update the display. Deletion or an endpoint change falls back to the snapshot name. Only registered Workspaces whose resulting names and directories still collide across different host, login or port values use `folder（connection name · user@host:port）`. These labels never change stored Workspace titles, Session data or execution targets; rename drafts use the stored title. Connection and Workspace changes refresh active Workspace followers. Missing snapshots show the explicit provider and target id instead of assuming a local directory.

The Remote services use the Gateway's global-resource access policy. Its records are not Workspace or Session resources, so sharing a Session does not grant access to this directory. Invalid input, removed records and stale revisions are structured refusals; storage failures leave no successful UI commit. An unknown storage outcome requires reopening the quarantined domain rather than retrying a write blindly.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [domain declaration](src/spec.ts) validates the entire saved directory under `hemi_ssh_servers`, version 1. One atomic document contains the creation-ordered records. The [service](src/index.ts) serializes mutations, checks record revisions and returns only durable results. Unloading stops admission, settles admitted operations and closes the domain. The [workspace service](src/workspaces.ts) stores deployments and append-only endpoint/directory snapshots in `hemi_ssh_workspaces`, version 1. Its pool gives each live instance a distinct identity and six independent Cordis service labels for SSH, FS, subprocess, sandbox, shell and PTC; Host providers remain unchanged. The final borrower drains consumers before closing the provider group. The verified `ssh.ptcLaunch` selects PTC, never the Host Node path.

The Host-only `SshAuthenticationPasswordMemory` collaborator reads, commits and discards password grants for an exact `SshPasswordEndpoint`; neither type belongs to the Remote response API. Its credential operations share the directory’s write queue. A dependency-scoped credential binding drains that queue before releasing the provider; native authentication separately joins prompt lookups and accepted-password writes during teardown.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH server UI](../ssh-servers-ui/README.md) — persistent connection picker, editor and remote folder selection.
- [Hemi subsystem](../../../docs/subsystems/hemi.md) — generated service interfaces.
- [SSH runtime](../../ssh/ssh/README.md) — separate remote execution and deployment requirements.

-----

<a id="model-experience"></a>
## Model Experience

None, as saved server references add no tools, prompt sections or Session events.

#### KV Cache effect

None; directory operations do not assemble model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Authentication uses native OpenSSH prompts on POSIX. Application restart or loss of the authenticated connection may require signing in again. Directory browsing needs no runtime on the server. Remote execution runs on the Node runtime Hemi provisions into its own cache (or an existing remote Node.js 24+); Linux servers with glibc older than 2.28, and musl systems such as Alpine, are warned about but may fail to run it.
- Private-key paths are references only; this service neither reads nor verifies the named file.
- The storage domain is process-owned; independent Host processes do not exchange live updates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
