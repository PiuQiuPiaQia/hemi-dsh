---
description: "Independent Hemi Memory tab for editing cross-session memory."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-memory-ui

English | [中文](README.zh.md)

## Summary

Open **Settings → Memory** to edit long-term memory, a dated log, or the scratchpad. Save commits the text. If the file changed since opening, the editor keeps the draft and asks you to reload. The web-app bundle mounts this Client plugin and the [Host settings service](../memory/README.md).

Choose a memory type and, for a daily log, its date under the Memory heading. The editor keeps save, error, and conflict feedback beside the text. Automatic memory behavior is documented by the [Host plugin](../memory/README.md#automatic-memory).

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Saved edits

#### What the model sees

The settings page contributes no prompt text. A subsequent `memory_read` or `memory_search` call can return saved edits.

#### Token effect

Saving adds no request tokens. A later tool result accounts for the text it returns.

#### KV Cache effect

Saving leaves prior requests and tool results intact. Later tool calls append their own results.

## Known Limitations and Deferred Work

- Choose a date to open a daily log. Unsaved text belongs to the open editor and is discarded when it closes.

### Dev Note

None.
