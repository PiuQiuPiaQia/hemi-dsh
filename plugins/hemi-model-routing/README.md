---
description: "Install Hemi model routing into a dsh profile as an independent config-only layer: pack the three tgz archives from a checkout, add them through the profile plugin command, and stay clear of compositions that already wire the routing rows."
kind: "package-bundle"
---

# @hemi/model-routing

English | [中文](README.zh.md)

## Summary

`@hemi/model-routing` is the config-only profile layer for installing Hemi model routing: `cordis.patch.yml` inserts the routing rows and the package itself owns no code. Pack it together with the two routing packages into three tgz archives and add all three to a profile through `dsh plugin --profile <name> add`. Routing behavior — the main and four role models and the per-conversation auto/fixed mode — belongs to those packages.

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

### Install into a profile

Pack and install from a checkout of this repository that has completed a workspace build, so the two routing packages carry the `lib/` outputs that `pack.mjs` verifies.

```text
pnpm install && pnpm run build
node plugins/hemi-model-routing/pack.mjs <destination>
```

`pack.mjs` packs `@deepseek-ai/dsh-hemi-routing`, `@deepseek-ai/dsh-hemi-routing-ui`, and `@hemi/model-routing` into `<destination>` (default `dist/`) and writes `packages.json` there with each archive's file name, version, and SHA-256.

Add all three archives in one profile plugin command — the normal entry point, which forwards its arguments verbatim to pnpm inside the profile directory:

```text
dsh plugin --profile <name> add \
  <destination>/deepseek-ai-dsh-hemi-routing-<version>.tgz \
  <destination>/deepseek-ai-dsh-hemi-routing-ui-<version>.tgz \
  <destination>/hemi-model-routing-<version>.tgz
```

Read the exact file names from `<destination>/packages.json`. `@hemi/model-routing` declares the two routing packages as peer dependencies at matching versions; one command adding all three archives satisfies them.

Install this version on the matching official Web composition with its standard preset, before applying user preset overrides. Install it only on compositions that carry no built-in Hemi routing rows: the web-app bundle in this checkout already wires `hemi-routing-settings`, `hemi-routing`, and `hemi-routing-ui`, and adding this layer on top inserts those rows again. Profiles composed from official upstream bundles carry no such rows.

### What you get

The layer inserts two root profile rows: `hemi-routing-settings` (the root-scope settings service `@deepseek-ai/dsh-hemi-routing/settings`, seeded with an empty `main` and `roles`) and `hemi-routing-ui` (the client plugin `@deepseek-ai/dsh-hemi-routing-ui`). It replaces the standard preset configuration with the fork’s standard capabilities, without the separate memory plugin, and enables the native `subagent` role allowlist. Four native presets (`explorer`, `oracle`, `fixer`, `designer`) supply role personas and shared tools; model routing is mounted inside standard. Waiting, cancellation and result notices remain native.

From the gear beside Automatic routing in the conversation model menu, or Settings → Models → Configure model routing, pick a main model and one model for each of the four roles — Research, Review, Execution, and Design (`explorer`, `oracle`, `fixer`, `designer`) — from the configured model catalog. A role left on Follow main model uses the main model; provider and model ids cannot be typed in.

Each ordinary conversation saves its own auto/fixed preference. Every root Session starts fixed — children inherit the delegating parent's actual model; enabling auto routes that Session's tree from the next turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The payload consists of [cordis.patch.yml](cordis.patch.yml), [standard.patch.yml](standard.patch.yml) and [roles.patch.yml](roles.patch.yml). Run `node plugins/hemi-model-routing/sync-config.mjs --write` after changing the owning standard preset or `packages/hemi/routing/roles.patch.yml`; packing rejects stale generated configuration. The Hemi composer uses a lower slot priority to shadow official clients that lack `showComposer`. [pack.mjs](pack.mjs) packs this package together with `packages/hemi/routing` and `packages/hemi/routing-ui`; the tests live in [tests/installed-smoke.mjs](tests/installed-smoke.mjs).

Turn and step semantics in brief, owned by the routing package: each turn's first claimed message captures one plan of mode, main, and role routes; in auto the plugin selects the configured main model before the loop reads the step's selection, and delegations bind the plan's role route. A manual model selection takes effect from the next step, not the next turn; steps already prepared keep their captured routes, and dispatched delegations keep their bound routes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Routing](../../packages/hemi/routing/README.md) — delegation roles, turn and step semantics, the settings namespace, and failure behavior.
- [Routing UI](../../packages/hemi/routing-ui/README.md) — the shared editor, save behavior, and UI boundaries.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly: this layer inserts rows only, and each inserted row's package owns that row's model-facing behavior.

#### KV Cache effect

The layer adds no request prefix; a changed routing selection can change provider-side cache reuse for later requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- In Hemi, select a concrete model to enter fixed mode, including the model currently used by automatic routing. The legacy DSH menu uses a switch.
- There is no cross-model fallback: enabling auto without a main model fails with `HEMI_ROUTING_MAIN_REQUIRED`, and an unresolvable route at delegation time fails with `HEMI_ROUTING_ROUTE_UNRESOLVED`.
- Role duties are prompt-level guidance: no per-role tool isolation exists, and the generic `subagent` tool can still start children on other routes.
- Turn plans are process-local: a Host restart mid-turn does not restore the captured plan, and later delegations in that turn read the live configuration.
- Mode preferences belong to the installing profile: they are not exported with the Session, do not migrate across profiles, and are not inherited by forked Sessions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`node plugins/hemi-model-routing/tests/installed-smoke.mjs <area>` prepares a fresh `DSH_HOME` with a clean official composition, packs the three archives, installs them through the real `dsh plugin` entry point, launches the real Host, and checks request routing, per-conversation mode isolation, and restart behavior end to end; `tests/expected/installed-routes.json` pins the expected request bindings.

The browser check defaults to the Playwright build pinned by `apps/web`; install it once by running `pnpm exec playwright install chromium` in `apps/web`, or point the smoke at an installed system Chrome with `HEMI_ROUTING_BROWSER_CHANNEL=chrome`.

</details>
