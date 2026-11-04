---
description: "Preset explorer/oracle/fixer/designer delegation roles with user-chosen model routes and per-conversation auto/fixed routing."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-routing

English | [中文](README.zh.md)

## Summary

`dsh-hemi-routing` ships four preset delegation roles — `explorer` (read-only reconnaissance), `oracle` (independent analysis), `fixer` (carry out changes), `designer` (user-facing interface) — and one `hemi_delegate` tool that binds each role to a user-chosen model route. A per-conversation mode decides who routes: in auto mode the plugin selects the configured main model each turn and binds every role; in fixed mode nothing is routed and children inherit the parent's actual model.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Client interface](#client-interface)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The package contributes two profile rows. The root-scope settings service loads as `@deepseek-ai/dsh-hemi-routing/settings` under entry id `hemi-routing-settings`; the agent preset plugin loads as `@deepseek-ai/dsh-hemi-routing` inside a preset's `plugins`. The settings card edits the `hemi-routing-settings` namespace through the standard settings pipeline.

The namespace holds `main` (the auto-mode main route, `null` until configured), `roles` (one route per canonical role id: `explorer`, `oracle`, `fixer`, `designer`), and `sessionModes` (one saved auto/fixed preference per root Session id). A route is `{ provider, model, reasoningEffort? }` with non-empty `provider` and `model`; an empty `reasoningEffort` means the model default. Role ids and route fields are validated at Loader config resolution, so unknown roles or malformed routes reject both at load and before a settings write persists. Older tables keyed `research`/`review`/`execution`/`design` map one-to-one onto the canonical roles when read. Editing a role saves the complete table with canonical keys and preserves the other assignments.

Every root Session starts in fixed mode: the plugin routes nothing, and a `hemi_delegate` child inherits the delegating parent's actual model. Enabling auto saves the per-Session preference through the settings pipeline and routes that Session's tree from the next turn: each turn's first claimed message captures one plan of mode, main, and roles, and in auto the plugin selects the configured main model before the loop reads the step's selection. Delegations bind the plan's role route; an unconfigured role follows main. Children never choose their own route through the tool.

The lead delegates when a role can contribute enough evidence, specialized judgment, parallelism, or context isolation to justify the handoff and verification. It selects the role by the expected result and honors the user’s explicit assignment. The same decision rules apply in automatic and fixed modes.

Role delegation waits for the child’s result in the current turn by default. Independent calls in the same tool batch may run concurrently. A child failure returns a tool error, and stopping the parent cancels the foreground child. Set `background: true` for an explicitly requested background task. That call returns the child ID after startup and delivers its result through the parent’s inbox.

A manual model selection takes effect from the next step, not the next turn: the parent's following requests run on the selected route, and delegations of later steps follow the parent's actual route instead of the turn's auto routes. Steps already prepared keep their captured routes, and delegations already dispatched keep their bound routes. In the Hemi picker, choosing any concrete model saves fixed mode before applying the selection. This also covers a choice identical to the current route.

The mode is a future-execution preference of the current profile: it is saved in the plugin settings namespace, never exported with the Session, and neither migrates across profiles nor inherits into forked Sessions. No Hemi session events are recorded, so plain Session logs stay readable by every harness build.

A routing-mode write is serialized per Session and resolved only after the settings pipeline persisted it. A failed save stays visible and blocks the Session's next step until a manual mode switch retries it; unloading the plugin stops new submissions without joining ConfigEditor transactions from its cleanup, because their Loader reconciliation may await that same cleanup. Callers retain the result of an accepted transaction; an unload with unsettled changes logs a warning and does not confirm persistence. After reopening, check the saved routing mode before continuing. Auto mode with a cleared main route fails closed the same way: the step is blocked and the host log names the missing main model, instead of silently reusing a stale route.

Delegation depth follows the official subagent policy: the optional `maxDepth` plugin config mirrors `dsh-tool-subagent` (`0` forbids delegation; omission reads the Host depth setting), and disabled delegation or depth limits reject the call through the standard runtime.

<a id="understand-the-implementation"></a>
## Understand the implementation

The root service is a `TypertRemoteService` (`hemiRoutingSettings`) that owns the config schema and validates every auto route against the live LLM registry when auto mode is enabled. Turn planning runs on the first claimed message of a turn through the official `agent/inbox/claimed` event, before the loop reads the step's model. The official `agent/pre-step` waterfall captures a service-owned step-mode snapshot for the root agent and enforces fail-closed blocking; `hemi_delegate` resolves the step's route against the turn plan, so a mid-turn mode change never leaves the parent on one route while its children bind another. Mode writes go through `ctx.settings.mutate` as one path-addressed preference per Session, guarded by a token fence so a stale write settlement cannot overwrite a newer save, and `hemi_delegate` starts children through the standard `ctx.subagents.startActivation` with hard-bound `agentOptions`.

<a id="client-interface"></a>
## Client interface

The client switches the mode through the generated Remote — `ctx.remote.hemiRoutingSettings.setEnabled(agent, enabled, signal?)` returning `RemoteResult<void>`; only the root Session may switch, and enabling with a missing main or an unresolvable route fails with `HEMI_ROUTING_MAIN_REQUIRED` or `HEMI_ROUTING_ROUTE_UNRESOLVED`. The settings card reads and writes `main`, `roles`, and `sessionModes` as immediate volatile fields of the `hemi-routing-settings` namespace, so the current Session's mode follows its saved preference without any session projection.

<a id="known-limitations-and-deferred-work"></a>
## Known limitations and deferred work

Role duties are prompt-level guidance: this release enforces no per-role tool isolation, because no existing seam tags a child with its delegation role, and the generic `subagent` tool (with `modelSelection` enabled in its composition) can still start children on other routes. The legacy DSH menu can still exit auto through its mode switch. There is no failure recovery across models: an unresolvable route at delegation time surfaces as an error, with no fallback. A delegation whose host restarted mid-turn reads the live config, because turn plans are process-local. Mode saves are serialized per Session but not across Sessions; concurrent first-time saves of different Sessions rely on the settings pipeline's own edit lock.
