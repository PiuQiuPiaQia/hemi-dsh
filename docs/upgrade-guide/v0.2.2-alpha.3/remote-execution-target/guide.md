---
kind: upgrade-guide
description: "Older Harness builds refuse Sessions that record an explicit execution target."
---

# Keep the recorded Session execution target

English | [中文](guide.zh.md)

## Change

A Session can record an immutable `executionTarget` in its header. The reference distinguishes execution environments even when their directory paths match. Older builds reject this header field; they may report an invalid or corrupt header rather than an unsupported feature. Sessions without the field retain their existing representation. Workspace storage uses domain version 3 to retain the same reference; reads accept version 2, while writes stamp version 3. Older Workspace readers refuse that version instead of interpreting remote paths as Host directories.

Explicit execution targets do not inherit the deployment-default extra writable roots or its `DSH_HOME` and `DSH_PROFILE_DIR` paths. Target-bound SSH providers reject per-call policies carrying those extra roots. Search uses `rg` from the target's PATH; the packaged binary remains local to the Harness machine.

## Migration

1. Open targeted Sessions with a build that understands [`SessionHeader.executionTarget`](../../../subsystems/persistence.md#sessionheader--metadata-beside-the-log). Keep the Workspace domain, provider configuration and immutable target records with the Session data. Retain a backup before opening the data with a build that writes Workspace version 3.
2. If the target is unavailable, restore that execution environment. Do not delete `executionTarget` or replace it with a local directory to force a resume.
3. Plugin authors register the provider with `ctx.sessions.registerExecutionProvider`. During Agent setup, pass `agent.execution` to preset `mount`, `recompose` or `composeFrom`; do not activate remote shared plugins from the Agent-scoped Context.
4. Custom subprocess providers accept `SubprocessExecutable` in `resolveExecutable`: ordinary strings retain their lookup semantics; a packaged resource supplies a logical command and lazy `resolveLocalPath`. Invoke that locator only in a same-machine provider. Remote providers resolve only the logical command in their own environment.
5. Give agentless target policy resolution its verified execution-world workspace. Do not copy deployment `additionalWritableRoots` into target calls. Install `rg` on the remote PATH when using search; missing programs fail without local execution.
6. Direct WorkspaceFiles callers must preserve required `WorkspaceFileScope.executionTarget` (`undefined` for the default). Session-origin media and native requests carry `sessionId`; directory launches may carry `workspaceId`. Native opening requires a verified Host mapping, not a same-spelled remote path.
7. Custom suggestion-menu views handle nonselectable `failed` groups; source failure is not a successful empty result.
8. Confirm that reopening or exporting the Session preserves both the provider and target id. A refused resume must leave the stored log unchanged and must not start local execution.
