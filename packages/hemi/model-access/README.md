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

Model capability edits use the settings revision observed when the editor opens and preserve unrelated model fields. API and catalog-backed subscription overrides use `llm-pi-ai`; the Hemi-owned GLM adapter reads `subscriptionModelOptions.bigmodel` from this plugin’s settings. Optional fields can be removed to restore adapter defaults. Changes affect later model resolutions; existing prepared requests retain their model configuration.

Subscription discovery performs a new network request on every open or refresh and never substitutes the installed model list after a failure. Codex uses the signed-in account’s `/backend-api/codex/models` endpoint; Claude and Copilot query their authenticated model APIs. GLM reads the official live ZCode Coding Plan release through `/api/v1/client/configs` and its public CDN; this is the published personal/team plan catalog, not an account-specific entitlement check. Public catalog requests carry no account credential. Unsupported replies and service failures leave existing model selections unchanged. `subscriptionDiscovery` configures request duration, catalog size and the external Codex/ZCode client versions.

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
