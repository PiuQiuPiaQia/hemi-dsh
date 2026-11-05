---
description: "Host-side connection tests for the Hemi model settings page."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-model-settings

English | [中文](README.zh.md)

## Summary

The profile owner can test a configured model using its saved provider settings and credential. The service sends a short request and reports whether it returned the expected tool call. It executes no tools and writes no conversation history.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Explicit connection test

#### What the model sees

A test sends a synthetic prompt and tool schema through the saved route without conversation history. The response is inspected without executing tools.

#### Token effect

Each explicit test uses a `128`-token output limit and may be billed by the provider.

#### KV Cache effect

The test is an independent request and does not alter any conversation prefix.

## Known Limitations and Deferred Work

- The test covers saved provider settings. A response without a tool call does not establish whether the model can call tools.

### Dev Note

None.
