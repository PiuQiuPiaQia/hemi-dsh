---
kind: upgrade-guide
description: "VVCode single-group settings become independent group connections with per-group model selections."
---

# VVCode connections support multiple groups

English | [中文](guide.zh.md)

## Change

Hemi profiles that contain the single-group `hemi-model-access.vvcodeConnection` setting use independent group connections under `vvcodeConnections`. The VVCode card opens a management dialog listing every application-authorized group instead of switching one current group. Each group has its own model key, catalog and enabled models; account balance and active subscriptions remain account-wide.

The existing group's provider ID stays `vvcode`, preserving saved Session model references. Additional groups receive independent provider IDs. New models are not enabled automatically. Model labels include their group so identical model IDs remain distinguishable.

## Migration

1. Keep the existing profile patch and credentials store. Hemi adopts the saved group, key reference, selected models and model overrides; no manual key copying or reauthorization is required for this conversion.
2. Open **Settings → Model connections → Subscriptions → VVCode**, then open its group and model manager. Confirm that the saved group's models remain selected. Unsynchronized groups have no selected models.
3. Use the dialog's single refresh control to update groups and models. Reopening the dialog reuses a successful result for the same authorization. These reads do not create or reveal model keys. Select models and save; only newly enabled groups without a saved connection need key-creation confirmation. Cancelling the dialog discards checkbox edits without preparing a connection. Existing connections are reused.
4. Select the same model from two groups to confirm their labels identify different groups. Disabling it in one group must not disable it in the other.

An interrupted conversion retains the old settings until the group collection is committed. If a directory read fails, use the shared fetch control to retry; saved selections remain unchanged. Do not delete credentials or repeat a token creation whose outcome is unknown. [The model-access reference](../../../../packages/hemi/model-access/README.md) describes authorization and recovery limits.
