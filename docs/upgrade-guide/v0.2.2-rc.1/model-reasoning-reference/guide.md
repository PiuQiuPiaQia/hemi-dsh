---
kind: upgrade-guide
description: "Catalog references supply compatible reasoning offers, and contradictory explicit effort configurations are rejected."
---

# Reasoning capabilities follow one model declaration

English | [中文](guide.zh.md)

## Change

A `catalogProvider` reference can supply its reasoning flag and effort map when the source and target use compatible OpenAI effort encoding. Hemi also resolves identified model capabilities independently of the connection's provider name, with explicit effort declarations taking priority. It preserves supported model levels and uses protocol fallback only when no usable offer resolves; known non-reasoning models and explicit disabling never receive fallback levels. Compatible model-specific thinking formats control enable/disable parameters without importing vendor endpoints or authentication. VVCode and ordinary API connections use the same profile rules.

An explicit `reasoningEfforts` dictionary together with effective `compat.supportsReasoningEffort: false` is contradictory. Strict configuration writes now reject it; deferred reads keep a diagnostic and withhold that model instead of offering levels that the request does not send. A deployment disabling effort parameters on a native reasoning model must also declare `compat.thinkingFormat`: OpenAI-format routes withdraw controllable efforts, while a declared vendor format retains its own thinking channel.

## Migration

1. If you explicitly configured effort levels, check the route and model `compat.supportsReasoningEffort` values. Keep the dictionary only when the endpoint accepts those effort parameters; otherwise remove it or set `reasoningEfforts: false`. If disabling parameters for a native reasoning model, declare the actual thinking format instead of leaving its encoding unspecified.
2. Keep existing `reasoningFallbacks` settings. OpenAI and Anthropic deployment defaults remain available when no usable model offer resolves; they are policy, not server capability detection. For ambiguous model IDs, an explicit `catalogProvider` chooses the intended installed capability record.
3. Open the model selector and check the offered levels. Catalog-backed models follow the referenced supported levels, while VVCode also retains configured default efforts. Unsupported levels are rejected before a model request is sent.

A matching model ID is a catalog reference, not verification of the gateway's upstream model. [Model connection settings](../../../../packages/hemi/model-access/README.md) describe overrides and gateway defaults.
