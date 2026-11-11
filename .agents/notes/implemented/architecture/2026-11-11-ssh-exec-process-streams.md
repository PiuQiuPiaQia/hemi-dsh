# Agent Note: Process streams inside the SSH exec channel

Status: implemented

English | [中文](2026-11-11-ssh-exec-process-streams.zh.md)

## Problem

The [original SSH provider](2026-09-11-posix-ssh-runtime.md) gave each process stream an OpenSSH forwarding channel. The forwarded Unix socket needed mutual endpoint authentication against same-user path replacement. The selected TLS-PSK cipher is available in standalone Node and unavailable in the Electron Host runtime, so remote file RPC could work while commands failed before launch.

## Decision

Process data uses the same authenticated SSH exec channel as administrative RPC. The helper reserves connection-scoped stream identifiers and acknowledges attachment before launch. Binary frames carry program bytes. Each stream has its own receive window, bounded writes and half-close state. A paused reader stops credit for its own stream. The writer admits one bounded process-data frame at a time alongside administrative frames. The helper pipes target I/O into this protocol and keeps its private administrative descriptors out of the target's stdio.

## Alternatives considered

**Keep forwarded sockets with TLS 1.3 mutual certificates.** This preserves OpenSSH's native per-channel flow control and adds temporary certificate issuance, pinning and exchange for the forwarded endpoints.

**Run a persistent remote Agent and service endpoint.** This moves model execution, authorization and Session ownership to the remote service and introduces a separate deployment and reconnection lifecycle. The SSH execution provider keeps those responsibilities on the Host.

## Consequences

The client and helper must deploy protocol 4 together. Hemi-managed targets resolve the new content-addressed helper from the current desktop installation while retaining the saved server and directory. A single SSH transport still determines total bandwidth and loss. The regression tests cover a full output window, ongoing heartbeat and termination requests, duplex binary control and EOF, and refusal to attach a stream from a different helper connection.
