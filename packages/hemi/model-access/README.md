---
description: "Host operations for subscription authorization, quota and New API model import."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-model-access

English | [中文](README.zh.md)

## Summary

The profile owner can sign in to VVCode, ChatGPT Codex, Claude, GitHub Copilot and GLM Coding Plan. VVCode exposes every authorized group side by side, each with its own model key and selection. ChatGPT Codex and GLM Coding Plan have quota queries. Desktop New API import verifies an isolated site login, discovers group models and creates a token from the confirmed plan; existing tokens can also be imported manually.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

DeepSeek account discovery delegates to the registered `deepseek-account` adapter, preserving its authentication and model-admission policy. Selected models are read from the native adapter, while discovery reloads its complete catalog. Add/remove operations persist the provider’s `selectedModels` without changing credentials; removing the last model saves an empty selection. Model edits write `modelOverrides` in that provider’s declared settings namespace, translating input types to `inputModalities`; they never create a Pi provider or replace the account catalog.

Disconnecting a subscription deletes its grant and drops the models that grant selected, so the provider offers no model until the account is connected again. GLM and VVCode selections are removed from `subscriptionModels`; VVCode also clears every owned group binding, key reference and model-option entry. Other subscription routes are removed from the `llm-pi-ai` profile, unless an API key names that route, in which case the route and its models stay because they serve that API connection.

New GLM Coding Plan authorization uses the Z.ai China browser flow. Sign in with an account linked to the BigModel account that holds your plan. If the link is missing, authorization stops before requesting a project token. Existing GLM grants and model selections do not require migration or sign-in again. Plan eligibility and credits remain subject to the provider.

Model capability edits use the settings revision observed when the editor opens and preserve unrelated model fields. API and Pi subscription overrides use `llm-pi-ai`; the Hemi-owned GLM and VVCode adapters read their entries in `subscriptionModelOptions` from this plugin’s settings. Optional fields can be removed to restore adapter defaults. Changes affect later model resolutions; existing prepared requests retain their model configuration.

Other subscription discovery performs a new network request on every open or refresh and never substitutes the installed model list after a failure. Codex uses the signed-in account’s `/backend-api/codex/models` endpoint; Claude and Copilot query their authenticated model APIs. GLM reads the official live ZCode Coding Plan release through `/api/v1/client/configs` and its public CDN; this is the published personal/team plan catalog, not an account-specific entitlement check. Public catalog requests carry no account credential. Unsupported replies and service failures leave existing model selections unchanged. `subscriptionDiscovery` configures request duration, catalog size and the external Codex/ZCode client versions. The Codex catalog request claims `subscriptionDiscovery.codexClientVersion`, and the backend omits models whose minimal client version exceeds that claim.

Imported API and VVCode models inherit names, input types, token capacities and reasoning capabilities by exact model id, independently of the connection's provider name. An explicit `catalogProvider` selects the capability source; ambiguous automatic matches retain route defaults. Explicit model overrides take priority. Capability inheritance never replaces the connection's endpoint, authentication or headers, and an inherited output capacity does not impose a request output cap. Existing connections use the same resolution without rewriting saved settings.

Reasoning resolution uses explicit offers first, then the identified model's supported levels, then the configured `reasoningFallbacks` when no usable levels resolve; a route without a declared protocol follows the one its installed catalog's shipped models agree on. A known non-reasoning model or an explicit disabling setting never receives fallback levels. Protocol defaults use `medium` for OpenAI Chat Completions, Responses, and Codex Responses and `high` for Anthropic Messages. The request protocol owns parameter encoding; a compatible model-specific thinking format also controls enabling and disabling thinking. These defaults are ephemeral and shared by selectors and requests. Anthropic fallback models use adaptive thinking unless explicitly configured otherwise. The GLM Coding Plan route gives a selected ID its shipped model catalog does not list the same Anthropic Messages fallback; listed IDs keep their shipped levels.

Desktop New API import resolves each model’s request protocol from the site’s declarations, preferring OpenAI Chat Completions when the site declares both it and Anthropic Messages. It verifies the chosen protocol with the new token before saving.

VVCode uses browser authorization with PKCE and a local loopback callback. Its management PAT stays in the credentials store; inference uses a separate model API key per group and always sends `X-AI-App: hemi-dsh`. The directory read lists every authorized group with its read-only model directory — `GET /api/desktop/groups?app=hemi-dsh` plus one `GET /api/user/models` per group under the PAT's `profile:read` scope — so every group is browsable and selectable without any key: the read never creates a token or key and never reaches `/v1`. A group whose model read fails keeps its previous IDs and reports `catalogError` on its row until the single-group refresh or the next directory read retries it. The single-group refresh verifies live authorization, persists confirmed group metadata, and re-reads that read-only directory; it never creates, verifies or reveals a token. A connection-modal save prepares every changed group without a binding — reusing its recorded token or key reference, or creating the group's key exactly once — validates every selection against the group's key catalog, re-reading a bound group's live catalog when the save enables a model that catalog does not list yet, and then commits all changed groups' bindings and selections in one atomic settings write. Any addition re-reads the authorized groups once: an added group the live list no longer names, or that a later read confirmed revoked, refuses the whole save, and a failed save keeps every saved selection and pending token ID reusable, so a retry never re-creates. Every group owns a stable provider route — the migrated legacy binding keeps `vvcode`, every other group derives `vvcode-group-…` from origin, account and group — so the same model ID under two groups resolves two keys, and published model names carry one ` · group` label that the options editor strips back off. A group a successful read no longer names is marked revoked: its key and selection stay saved, but its route stops serving until a later read names it again. A failed read changes nothing. An expired account keeps its rows for local deselection and blocks additions, refreshes and inference. The legacy single-group fields migrate atomically into `vvcodeConnections` on the next write and keep serving until then. `vvcode` configures the HTTPS origin and request budgets.

`vvcodeUsage` reads the wallet balance and active subscriptions without invoking a model. A credential-free `/api/status` read declares the display unit — USD, CNY with the site's USD exchange rate, a custom currency with its rate and symbol, or raw TOKENS — and a missing or unusable configuration fails the whole read instead of assuming defaults. The balance comes from `/api/user/self` and needs only the grant's `profile:read` scope; subscriptions come from `/api/subscription/self` and additionally need the read-only `wallet:read` scope. A grant without that scope, or a server-side refusal of that read, reports subscriptions as reauthorization while the balance still loads. Balance and subscriptions fail independently, each active subscription is reported on its own without accumulating totals, and a management 401 expires the account until the next sign-in.

Existing manual API providers, including one named `vvcode`, remain owned by `llm-pi-ai`. The subscription's empty account route chooses an unoccupied identifier. Only saved group bindings use the subscription's model-option namespace; matching a provider-name prefix does not transfer ownership.

Remote request and response fields are defined in [`src/types.ts`](src/types.ts).

To investigate a Codex WebSocket interruption, search by session ID in `$DSH_HOME/logs/codex-websocket.jsonl` (`~/.hemi-dsh/logs/codex-websocket.jsonl` on default Hemi desktop installs). The file is created when the SDK first reports a WebSocket failure. Each line records the route, time, whether streaming started, the close code if available, and the SDK outcome including any SSE fallback. The local log contains no prompts, tokens, or raw close reasons. If writing fails, the Host logger receives the redacted diagnostic. Delete the file to clear old records.

## Model Experience

### Import validation

#### What the model sees

`New API` validation sends short independent requests to the selected model and protocol before saving routes. Account authorization and quota queries contain no conversation history.

#### Token effect

Explicit validation consumes provider tokens; account status and quota queries do not invoke a model.

#### KV Cache effect

Validation uses independent requests and does not replace conversation prefixes. Changing imported routes can change later provider cache reuse.

## Known Limitations and Deferred Work

- Browser-assisted import requires desktop and encrypted storage. Other clients can import an existing New API token. Claude and GitHub Copilot expose authorization status.
- VVCode browser authorization requires the browser and Host on the same computer. Its PAT expires after 30 days without refresh-token support; expired or rejected authorization retains selections but blocks inference until reauthorization. Disconnecting removes local credentials, not server-side PATs or model keys. Created model keys have no separate quota or expiry and remain subject to account funds and group permissions; manage remaining server-side tokens on VVCode.
- VVCode records token creation before dispatch and never automatically repeats an unobserved creation. A returned token ID supports recovery. Without an ID, ordinary exact-name lookup cannot recover an application-exclusive token: creation stops and the owner must confirm the server state with VVCode before disconnecting and reconnecting. The read-only directory can list models a group's key does not advertise; enabling such a model is refused whole instead of silently skipped.
- VVCode grants issued before the `wallet:read` scope existed keep their original scopes: the balance still loads, but subscriptions report reauthorization until the account signs in again and the new grant includes the scope.

### Dev Note

None.
