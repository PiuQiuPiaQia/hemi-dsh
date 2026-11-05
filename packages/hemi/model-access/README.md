---
description: "Host operations for subscription authorization, quota and New API model import."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-model-access

English | [中文](README.zh.md)

## Summary

The profile owner can connect ChatGPT Codex, Claude and GitHub Copilot using Harness OAuth, and GLM Coding Plan using the migrated Hemi authorization flow. ChatGPT Codex and GLM Coding Plan have quota queries. On desktop, the New API coordinator uses an isolated sign-in window, verifies the site account, discovers models by group and creates a token from the confirmed plan. The owner can also import an existing token manually.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

DeepSeek account discovery delegates to the registered `deepseek-account` adapter, preserving its authentication and model-admission policy. Selected models are read from the native adapter, while discovery reloads its complete catalog. Add/remove operations persist the provider’s `selectedModels` without changing credentials; removing the last model saves an empty selection. Model edits write `modelOverrides` in that provider’s declared settings namespace, translating input types to `inputModalities`; they never create a Pi provider or replace the account catalog.

Model capability edits use the settings revision observed when the editor opens and preserve unrelated model fields. API and Pi subscription overrides use `llm-pi-ai`; the Hemi-owned GLM adapter reads `subscriptionModelOptions.bigmodel` from this plugin’s settings. Optional fields can be removed to restore adapter defaults. Changes affect later model resolutions; existing prepared requests retain their model configuration.

Other subscription discovery performs a new network request on every open or refresh and never substitutes the installed model list after a failure. Codex uses the signed-in account’s `/backend-api/codex/models` endpoint; Claude and Copilot query their authenticated model APIs. GLM reads the official live ZCode Coding Plan release through `/api/v1/client/configs` and its public CDN; this is the published personal/team plan catalog, not an account-specific entitlement check. Public catalog requests carry no account credential. Unsupported replies and service failures leave existing model selections unchanged. `subscriptionDiscovery` configures request duration, catalog size and the external Codex/ZCode client versions.

Imported API models inherit names, input types and token capacities by exact id from the installed catalog. OpenAI and Anthropic canonical entries take priority; other matches require the same protocol and agreeing capabilities. Unknown or ambiguous ids retain route defaults. The ephemeral `catalogProvider` reference preserves explicit overrides and never imports vendor endpoints, authentication, compatibility flags or request output caps. Existing connections use the same resolution without rewriting saved settings.

For a configured model absent from the installed catalog and without an explicit reasoning offer, `reasoningFallbacks` supplies protocol effort choices: OpenAI Chat Completions and Responses default to `medium`; Anthropic Messages defaults to `high`. Explicit offers, explicit disabling and installed catalog entries take priority. These defaults are ephemeral, apply to both selectors and requests, and do not rewrite saved connections. Anthropic fallback models use adaptive thinking unless explicitly configured otherwise.

Remote request and response fields are defined in [`src/types.ts`](src/types.ts).

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

### Dev Note

None.
