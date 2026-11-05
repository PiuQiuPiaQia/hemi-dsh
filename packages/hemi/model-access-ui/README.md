---
description: "Independent Model Connections settings page for Hemi."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-model-access-ui

English | [中文](README.zh.md)

## Summary

The Desktop profile mounts Hemi’s Model Connections page for subscription accounts, New API import and API key connections. Subscription accounts show weekly and five-hour quota when available. Each model offers compact settings, test and removal icons with localized accessible names and tooltips. Discover models in a searchable dialog and confirm selections before adding them. API connections and subscriptions support display names, token limits and text/image input overrides. Removing the final model keeps its connection and credential.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Key presets supply connection addresses without injecting model IDs. Discover or enter model IDs before saving a connection. Discovery dialogs request a fresh server list on open and provide an explicit Refresh action. A failed refresh shows an error with retry and clears the candidate list; it does not remove saved models. New API connections use the same settings editor after import.

Model settings edit the display name, context window, maximum output tokens and text/image input types. Blank optional fields and inherited input types use adapter defaults. New connection drafts are written only when the connection is saved; settings for an existing model have their own confirmation. Cancelling either dialog leaves its settings unchanged.

## Model Experience

### Connection editing

#### What the model sees

The editor submits account operations to the `model-access` Host plugin, which owns import validation requests.

#### Token effect

Editing alone sends no model requests; explicitly validating an import can consume provider tokens.

#### KV Cache effect

The editor adds no conversation prefix; selecting an imported model can change provider cache reuse.

## Known Limitations and Deferred Work

- Browser login is available in the desktop shell. The existing-token form is available without the desktop bridge.

### Dev Note

None.
