---
description: "Ownership and upstream integration rules for Hemi plugins and Electron adapters."
kind: "package-group"
---

# Hemi fork code

English | [中文](README.zh.md)

## Summary

Hemi feature plugins live in this directory. Non-plugin shell adapters live in [customizations](customizations/README.md). The skin plugin remains in [client/ui-hemi-skins](../client/ui-hemi-skins/README.md); installable composition layers live in [plugins](../../plugins/).

The [Hemi fork rules](../../docs/defensive-patterns/hemi-fork.md) own implementation placement, native behavior preservation, upstream comments, and validation requirements. The [fork ledger](../../hemi-fork-changes.md#hemi-customization-isolation) records retained modifications and upstream-merge checks.

Native runtime behavior remains documented in [model streaming](../../docs/subsystems/llm-streaming.md) and [subagents](../../docs/subsystems/subagent.md).

The [Hemi subsystem](../../docs/subsystems/hemi.md) documents the plugin service interfaces.
