---
kind: upgrade-guide
description: "Model catalog defaults can be null and default-model initialization requires an explicit provider."
---

# Provider-neutral Desktop startup

English | [中文](guide.zh.md)

## Change

Hemi Desktop opens the workspace independently of provider sign-in or API keys. Its introduction offers model configuration or workspace entry; DeepSeek sign-in, expiry and sign-out no longer select the application window. Existing credentials and Session logs are retained.

The default-model configuration accepts an explicit pair of `provider: null` and `model: null`. `currentSelection()` can return `undefined`, and `session/modelCatalog` can return `default: null`. A prompt without a selected model is refused with `session/model-not-selected` before its content is admitted. Existing Session selections remain unchanged.

`session/initializeDefaultModel` now requires an explicit `provider` argument. Account UI defaults retain their original behavior; Hemi Desktop explicitly disables account-owned onboarding and automatic default-model initialization.

## Migration

1. Update Remote callers to pass `{ provider: 'deepseek-account' }` when requesting DeepSeek account initialization; same-process callers pass `'deepseek-account'` to `initializeDefaultModel`.
2. Handle an absent `currentSelection()` and a null model-catalog default. Preserve explicit saved selections instead of substituting a provider.
3. Use both null default-model fields only for an intentionally unconfigured deployment. A single null field is rejected.
4. Start Desktop without provider credentials and confirm that the workspace and Model connections settings open. Select a model before sending a message; provider sign-out must leave the workspace open.
