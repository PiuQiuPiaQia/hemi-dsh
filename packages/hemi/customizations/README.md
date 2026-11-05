---
description: "Electron-only Hemi adapters imported by the desktop shell."
kind: "package-library"
---

# @deepseek-ai/dsh-hemi-customizations

English | [中文](README.zh.md)

## Summary

This package owns non-plugin Hemi adapters required by the Electron main process and sandboxed preload. Feature services remain in their Hemi plugins. The desktop shell imports the main adapter from this package and the browser-safe bridge from `/preload`.

The main adapter creates the isolated New API login window and registers the shell-provided IPC channel. Every operation runs the shell's sender authorization first. The shell disposes import work before shutting down the authenticated Host. The preload entry imports no Electron main-process code.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

### Desktop account operations

#### What the model sees

The `newApiImport` bridge adds no prompt text or tools. Model validation and account operations belong to [model-access](../model-access/README.md).

#### Token effect

The adapters issue no model request and consume no tokens.

#### KV Cache effect

The adapters do not change model request prefixes or existing conversation history.

## Known Limitations and Deferred Work

- The main entry requires Electron and cannot run in a headless DSH Host. It is imported by the desktop application rather than mounted as a Cordis plugin. Build and package it with the same fork version as the shell and model-access plugin. Upstream integration points are tracked in the [fork ledger](../../../hemi-fork-changes.md#hemi-customization-isolation).

### Dev Note

None.
