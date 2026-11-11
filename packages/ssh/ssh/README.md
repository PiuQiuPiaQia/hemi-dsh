---
description: "OpenSSH connection configuration and remote helper lifecycle for deployments composing POSIX file, process and sandbox providers."
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh

English | [中文](README.zh.md)

## Summary

`dsh-ssh` connects a POSIX Harness host to an installed helper on a POSIX SSH host. One deployment-owned OpenSSH alias supplies authentication and host identity; the paired filesystem, subprocess and sandbox providers use that connection. The connection verifies installed artifact digests before readiness; the helper owns remote cleanup when the connection closes or its lease expires.

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

Compose this service with [`fs-ssh`](../fs-ssh/README.md), [`subprocess-ssh`](../subprocess-ssh/README.md) and [`sandbox-ssh`](../sandbox-ssh/README.md) in a custom `dsh` profile. The host runs the Harness, model transport and Session storage; the remote machine supplies the files and processes. Headless profiles support this arrangement.

The helper validates additional writable roots on the wire; its enforcing provider requires physical directory paths on the remote filesystem. Read-only grants no write access to them.

### Deployment prerequisites

Both endpoints require Linux or macOS. The server must allow a non-PTY SSH exec session. A borrowed OpenSSH master also requires local connection multiplexing. Configure the alias, credentials and known-host entry before startup, or supply an endpoint-bound authenticated master through `authenticatedControlPath`: the service enables `BatchMode`, requires strict host-key checking, disables agent forwarding and adds no interactive authentication flow.

Install an [SSH helper executable archive](../ssh-helper-runtime/README.md), or the built helper script with its matching Node dependencies. Keep the runtime outside the workspace and writable temporary roots. They must also remain outside a backend’s replaced temporary tree, such as bwrap’s private `/tmp`; the workspace may still be under `/tmp`. Digest verification detects an unexpected installed artifact after helper startup; it does not make writable deployment files safe to execute or authenticate a malicious SSH host.

| Field | Default | Meaning |
|---|---|---|
| `host` | required | OpenSSH alias, DNS name, IPv4 or IPv6 address; legacy `user@host` is accepted |
| `username` | omitted | Explicit login; cannot be combined with a user embedded in `host` |
| `port` | omitted | Explicit TCP port, from 1 through 65535 |
| `identityFile` | omitted | Local private-key file path; this service never reads key contents |
| `authenticatedControlPath` | omitted | Absolute borrowed authenticated OpenSSH socket path, bound by its owner to this endpoint; this consumer never persists or terminates the master, and an unavailable socket fails without fresh transport |
| `launch` | required | `{ kind: "executable" }`, or `{ kind: "node-script", node: "/absolute/node" }` |
| `helper`, `workspace` | required | Absolute remote helper entry and default workspace |
| `executionTarget` | omitted | Immutable reference marking a non-default environment; Hemi supplies it for target-bound provider groups |
| `helperHash` | required | Lowercase SHA-256 of the installed helper entry |
| `launch.bootstrapPath`, `launch.bootstrapHash` | omitted | Paired remote PTC script and digest; only for `node-script` |
| `requestTimeoutMs` | `30000` | Connection and administrative-request deadline, from 1 through 2,147,483,647 ms |
| `maxFrameBytes` | `67108864` | Per-message JSON payload ceiling, at most 64 MiB |
| `maxPending` | `128` | Ordinary outstanding requests; heartbeat and bounded cleanup requests have reserved capacity |
| `leaseMs` | `30000` | Helper heartbeat lease, from 3000 to 600000 ms |

Pass the verified `ctx.ssh.ptcLaunch` as the `launch` configuration of [`NodePtcRuntime`](../../ptc-runtime/ptc-runtime-node/README.md). Executable deployments include their worker. Script deployments require both bootstrap fields for PTC; filesystem and Bash use may omit them. The getter refuses an unconfigured script bootstrap. The client rejects mismatched protocol versions, runtime kinds and helper digests before readiness.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The helper dispatches `fs.patch`, `fs.delete`, and `fs.move` through its sandboxed filesystem provider; strict schemas validate hunks, source/destination guards, and complete or partial move outcomes. Hunk payloads share the connection frame limit.

<details>
<summary>Implementation internals — click to expand</summary>

The helper’s authenticated SSH exec channel carries private administrative RPC and framed process streams. The helper reserves each stream on that connection before accepting launch. Program bytes stay inside binary frames, and each stream has an independent receive window. Administrative frames can queue between bounded process data frames. With `authenticatedControlPath`, the external owner retains the master.

Connection disposal requests remote cleanup and joins the SSH exec child. Transport loss rejects pending operations, aborts `ctx.ssh.signal` and invalidates the connection. The helper starts managed cleanup on SSH EOF, termination signals or heartbeat expiry. A disconnected client cannot confirm the remote outcome; operations are never reconnected or replayed automatically.

Failed startup and process results release their reservations after native quiescence; the bounded completion cache preserves the original rejection for later result reads. Helper shutdown also joins stream cleanup already in progress.

For terminals opting into shell activity observation, root exit retains the reservation and its remaining work. Activity RPC continues to reach the provider; explicit termination awaits quiescence before releasing endpoints and recording the completed result. Helper connection disposal and lease expiry retain their existing termination authority.

The connection disables the helper’s SIGUSR1 debugger activation: the script invocation uses `--disable-sigusr1`, and the executable invocation supplies that flag through `NODE_OPTIONS`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — execution coordinates, transport semantics and lifecycle ownership.
- [POSIX SSH decision](../../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md) — rationale, alternatives and required verification.

-----

<a id="model-experience"></a>
## Model Experience

None, as host aliases, authentication and stream capabilities are private deployment details and consumers own every model-visible operation.

#### KV Cache effect

This provider contributes no request-prefix content. Its consumers own model-visible tools and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No Windows endpoint, automatic provisioning, reconnect or replay is supplied.
- Remote preview reads require Session-scoped [workspaceFiles](../../api/workspace-files/README.md). Local-only [file suggestions](../../context/file-reference-local/README.md) and native Host application handoffs do not enumerate or open remote paths.
- The remote OS and helper process are trusted. File-effect policy retains the selected sandbox backend’s limits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
