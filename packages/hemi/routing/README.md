---
description: "Preset explorer/oracle/fixer/designer delegation roles with user-chosen model routes and per-conversation auto/fixed routing."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-routing

English | [中文](README.zh.md)

## Summary

`dsh-hemi-routing` ships four preset delegation roles — `explorer` (read-only reconnaissance), `oracle` (independent analysis), `fixer` (carry out changes), `designer` (user-facing interface) — as native DSH agent presets. The native `subagent` tool selects them with `agent_preset`; the host binds each selected role to its configured model. No separate delegation tool is registered. A per-conversation mode decides who routes: in auto mode the plugin selects the configured main model each turn and binds every role; in fixed mode nothing is routed and children inherit the parent's actual model.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Client interface](#client-interface)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The package contributes two profile rows. The root-scope settings service loads as `@deepseek-ai/dsh-hemi-routing/settings` under entry id `hemi-routing-settings`; the agent preset plugin loads as `@deepseek-ai/dsh-hemi-routing` inside a preset's `plugins`. The settings card edits the `hemi-routing-settings` namespace through the standard settings pipeline.

Automatic routing exposes four conversation-scoped effort levels: `low`, `medium`, `high`, and `max`. `sessionEfforts` stores overrides; `defaultReasoningEffort` defaults to `high`. The awaited pre-step captures the level with the turn’s routes, maps it to each main/role model’s advertised efforts, and records the concrete main selection through the native Session API. Matching levels win; maximum falls back through `xhigh` and `high` when necessary, while non-reasoning models receive no effort. Later edits apply on the next turn and do not change accepted child tasks. `setReasoningEffort` saves through the existing settings pipeline without leaving automatic routing.

The namespace holds `main` (the auto-mode main route, `null` until configured), `roles` (one route per canonical role id: `explorer`, `oracle`, `fixer`, `designer`), and `sessionModes` (one saved auto/fixed preference per root Session id). A route is `{ provider, model, reasoningEffort? }` with non-empty `provider` and `model`; an empty `reasoningEffort` means the model default. Role ids and route fields are validated at Loader config resolution, so unknown roles or malformed routes reject both at load and before a settings write persists. Older tables keyed `research`/`review`/`execution`/`design` map one-to-one onto the canonical roles when read. Editing a role saves the complete table with canonical keys and preserves the other assignments.

Fresh ordinary conversations capture `newSessionMode` and `newSessionEffort` from the last successfully saved explicit choices. Before any choice, the mode is `fixed` and a `null` effort uses `defaultReasoningEffort`. The Host saves a per-conversation snapshot before creation completes; a failed save rejects creation. Later choices do not reset existing conversations, reused blank drafts, resumed Sessions, forks, or children. Fixed-model defaults continue to use the native model-selection service. In fixed mode, the plugin routes nothing, and a native role child inherits the delegating parent's actual model. Enabling auto saves the per-Session preference through the settings pipeline and routes that Session's tree from the next turn: each turn's first claimed message captures one plan of mode, main, and roles, and in auto the plugin selects the configured main model before the loop reads the step's selection. Delegations bind the plan's role route; an unconfigured role follows main. The host binds role routes regardless of model-supplied route fields.

The lead delegates when a role can contribute enough evidence, specialized judgment, parallelism, or context isolation to justify the handoff and verification. It selects the role by the expected result and honors the user’s explicit assignment. The same decision rules apply in automatic and fixed modes.

Role delegation uses the native asynchronous `subagent` tool: an accepted start returns the child ID immediately, and completion is delivered through the parent inbox. Published children retain the native independent lifetime; this plugin changes only their model options and adds no waiting, cancellation, or result-delivery policy.

A manual model selection takes effect from the next step, not the next turn: the parent's following requests run on the selected route, and delegations of later steps follow the parent's actual route instead of the turn's auto routes. Steps already prepared keep their captured routes, and delegations already dispatched keep their bound routes. In the Hemi picker, choosing any concrete model saves fixed mode before applying the selection. This also covers a choice identical to the current route.

The mode is a future-execution preference of the current profile: it is saved in the plugin settings namespace, never exported with the Session, and neither migrates across profiles nor inherits into forked Sessions. No Hemi session events are recorded, so plain Session logs stay readable by every harness build.

A routing-mode write is serialized per Session and resolved only after the settings pipeline persisted it. A failed save stays visible and blocks the Session's next step until a manual mode switch retries it; unloading the plugin stops new submissions without joining ConfigEditor transactions from its cleanup, because their Loader reconciliation may await that same cleanup. Callers retain the result of an accepted transaction; an unload with unsettled changes logs a warning and does not confirm persistence. After reopening, check the saved routing mode before continuing. Auto mode with a cleared main route fails closed the same way: the step is blocked and the host log names the missing main model, instead of silently reusing a stale route.

The web/desktop bundle declares the four role presets in `presets/hemi-roles.patch.yml`, with their own persona and tool composition. The standard preset exposes all four through native `allowedAgentPresets`. Configure delegation backend and depth on `dsh-tool-subagent`; the routing plugin accepts its old `provider` and `maxDepth` fields only for profile compatibility.

The four roles are child-only presets. Hemi hides them from main-session mode and default settings while standard mode still delegates to each role through the native subagent tool.

In the standard preset, `@deepseek-ai/dsh-hemi-routing/overflow-compaction` recovers when both a conversation request and its automatic summary exceed their context windows. It selects smaller ranges using the summary model's estimated budget, keeps tool calls with their results, and checks remaining pressure against the conversation model's window. `maxAttempts` limits additional summary requests to four by default. Each successful segment is saved as a native checkpoint, and the engine owns the conversation retry.

<a id="understand-the-implementation"></a>
## Understand the implementation

The root service is a `TypertRemoteService` (`hemiRoutingSettings`) that owns the config schema and validates every auto route against the live LLM registry when auto mode is enabled. Turn planning runs on the first claimed message of a turn through the official `agent/inbox/claimed` event, before the loop reads the step's model. The official `agent/pre-step` waterfall captures a service-owned step-mode snapshot for the root agent and enforces fail-closed blocking; the native subagent model-options hook resolves the step's route against the turn plan, so a mid-turn mode change never leaves the parent on one route while its children bind another. Mode writes go through `ctx.settings.mutate` as one path-addressed preference per Session, guarded by a token fence so a stale write settlement cannot overwrite a newer save, and `subagent/resolve-agent-options` supplies hard-bound `agentOptions` before the standard runtime starts the child. Preset identity, child sessions, messaging, task boards and continuation use DSH native services.

The `hemiModelUsage` projection groups recorded calls by provider and model. Cache hit rates divide cumulative cache reads by cumulative full input tokens, including cache reads and writes. An omitted cache count is known to be zero only when the other disjoint token counts exhaust the exact full-call total; otherwise it remains unknown. Projection checkpoints rebuild from recorded events when the accounting version changes, so historical Sessions use the same rules without rewriting their logs.

<a id="client-interface"></a>
## Client interface

The client switches the mode through the generated Remote — `ctx.remote.hemiRoutingSettings.setEnabled(agent, enabled, signal?)` returning `RemoteResult<void>`; only the root Session may switch, and enabling with a missing main or an unresolvable route fails with `HEMI_ROUTING_MAIN_REQUIRED` or `HEMI_ROUTING_ROUTE_UNRESOLVED`. The settings card reads and writes `main`, `roles`, and `sessionModes` as immediate volatile fields of the `hemi-routing-settings` namespace, so the current Session's mode follows its saved preference without any session projection.

## Model Experience

### Native role guidance

#### What the model sees

When native `subagent` delegation is available, the plugin describes the four role duties and selects the configured provider, model and reasoning effort at child creation. The native tool owns startup receipts and completion notices.

#### Token effect

Role guidance adds fixed context while the tool is available; route binding adds no separate model request.

#### KV Cache effect

Role guidance repeats unchanged for the same available tools. Changing the main or role route can change provider-side cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Role duties are persona guidance; the shipped role presets share a tool composition rather than enforcing read-only permissions for explorer. Each preset can be customized independently. Unselected role presets leave generic child routing unchanged. The legacy DSH menu can still exit auto through its mode switch. There is no failure recovery across models: an unresolvable route at delegation time surfaces as an error, with no fallback. A delegation whose host restarted mid-turn reads the live config, because turn plans are process-local. Mode saves retain per-Session ordering. Explicit new-conversation preference commits and creation snapshots also share one service-owned queue, so a new conversation never captures a preference whose save is still pending or rolling back. Across windows, defaults reflect successful persistence, not click timing.

### Dev Note

None.
