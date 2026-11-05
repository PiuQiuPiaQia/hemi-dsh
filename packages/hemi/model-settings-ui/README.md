---
description: "Hemi Models and Routing settings page."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-model-settings-ui

English | [中文](README.zh.md)

## Summary

The Desktop profile adds a separate Model Connections settings entry. Its Hemi connection editor offers subscription, New API and API key methods, alongside routing and a test button beside each saved model. The original DSH Models page remains accessible from its own settings navigation entry.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Connection tests

#### What the model sees

The page delegates explicit model tests to the `model-settings` Host service and route editing to the routing settings service.

#### Token effect

Editing consumes no tokens; explicit tests consume the tested provider’s tokens.

#### KV Cache effect

The page adds no request prefix; selecting a different model can change cache reuse.

## Known Limitations and Deferred Work

- Browser-assisted New API login requires the desktop bridge. Subscription authorization and quota are supplied by the model-access Host plugin.

### Dev Note

None.
