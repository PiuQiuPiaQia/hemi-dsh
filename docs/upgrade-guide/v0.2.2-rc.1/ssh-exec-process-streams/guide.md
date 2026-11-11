---
kind: upgrade-guide
description: "SSH clients and installed helpers must match protocol 4 to carry process streams inside the SSH exec channel."
---

# Upgrade SSH clients and helpers to protocol 4

English | [中文](guide.zh.md)

## Change

Protocol 3 uses separately forwarded Unix sockets with TLS-PSK. Protocol 4 carries administrative requests and process streams through the authenticated SSH exec session. The connection requires a matching helper and verifies its installed digest before it accepts work.

## Migration

1. In Hemi Desktop, resume a Workspace or Session with a Hemi-managed helper to deploy the new bundled artifact to the saved server.
2. For a manually installed helper, install the matching script bundle or complete executable archive alongside the existing deployment. Point `helper` and `helperHash` at the installed entry and digest. For a script helper with PTC, update `launch.bootstrapPath` and `launch.bootstrapHash` together. See [SSH deployment](../../../../packages/ssh/ssh/README.md#use-this-package).
3. Reopen the connection and run a remote file read and `true` through Bash. PTC and terminal deployments can verify their usual commands on the same connection.
