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

The Desktop profile hides the native Account and Models tabs and the sidebar account menu; account controls remain in Model connections. The Subscription and API tabs support arrow keys, Home and End. Connect New API opens a dialog in the API tab. On desktop, the site protocol defaults to HTTPS. Select HTTP for a trusted self-hosted site that requires it. Sign in inside the dialog, then select I’ve signed in, continue. The only available token group opens automatically; if several groups are available, choose one. Check the models and select Import models. The app creates the token, verifies the models and saves the connection. Closing the dialog preserves drafts and does not cancel the native import; its progress or outcome remains visible in the API tab. If the dialog cannot read the import status, it retries and clears the warning once status is available. Successful imports refresh the connection list. Select Done to dismiss the result. Open Connect New API again to enter a new site. Without the desktop bridge, the dialog imports an existing token. Import failures map known codes to their standing advice (finish sign-in, retry the model list, reopen the site); any other failure shows the safe operation summary instead of the coordinator message.

All accounts in the Subscription tab use the same `SubscriptionCard` component. DeepSeek shares native sign-in and account state through `account.connection`, with topped-up and granted balances in place of quota bars. Login loads the native `deepseek-account` catalog automatically; the shared model rows provide settings and connection tests. Model removal and the searchable Fetch models dialog use the same controls as other subscriptions. The Fetch models icon sits before the reconnect action in each connected subscription header, with a localized tooltip. The native provider persists `selectedModels`, including an explicit empty list, while discovery reloads every serviceable candidate for adding models back. Quota and balance refresh use the same icon button, with localized tooltips and a disabled state while refreshing. Balance refresh and sign-out use native account operations, including confirmation of running-task impact.

VVCode keeps the account card compact, with saved model and group counts beside Manage groups and models. Each authorization reads all authorized groups once when the card mounts, and the dialog reuses that snapshot on every open, so repeated opening sends no request. The dialog shows collapsible model lists. Groups with enabled models start expanded. Search matches group and model names without clearing selections. Each group shows its usage multiplier and selected count; failed catalog reads leave totals unknown. Reading the directory only lists groups and models, without creating keys or requesting confirmation. A single Refresh directory action rereads the whole directory with one request; concurrent opens and reads reuse one in-flight read instead of aborting and reissuing it. A failed directory read keeps the last data visible with a notice, and a group with a failed catalog read shows a local retry notice instead of an empty model list; both retry through Refresh directory, which shows its progress on the button while pending. New models remain unchecked. Checkbox changes remain drafts until Save selection. If newly enabled models need a connection, one confirmation lists only those groups before Hemi creates or reuses their calling keys and atomically saves changed selections. Existing connections and removal-only saves need no creation confirmation. Cancel, Escape, outside click and Close discard drafts without saving or preparing connections. Refresh preserves draft choices for models still in the catalog. Saving keeps the dialog open until the write settles and one fresh directory read updates the account summary; failure retains the draft for retry and pending saves block dismissal. A new authorization, a failed or absent snapshot, and explicit refresh are the only reads beyond the mount read and the post-save read; there is no time-based polling. Saved selections make group-specific routes available in chat; unchecking clears only the local selection and keeps the remote key and catalog entry. Settings and tests use that group’s provider and require both saved and draft enablement. Empty directories, read failures and expired authorization have distinct notices. Expired authorization retains local selections for removal but disables enabling, settings and tests. Sign-in, cancellation, reconnect and local disconnect remain available. An unknown key creation outcome blocks further creation for that group even after refresh; confirm its status with VVCode before disconnecting and reconnecting. Revoke remote authorization through the VVCode website’s authorization token management.

The VVCode header shows the account balance and each active subscription’s remaining and total amount with its expiry, without adding subscription quotas to the wallet. Unlimited amounts and an empty subscription list are explicit. The UI formats server-normalized currency or token amounts without conversion. Refresh failures retain same-authorization values with a visible warning. Missing subscription permissions offer sign-in again while keeping the wallet visible; expired or replaced authorization clears prior usage and cancels pending reads.

Key presets supply connection addresses without injecting model IDs. Discover or enter model IDs before saving a connection. Once the editor holds a valid endpoint and a key — typed or the saved credential — it reads the server list once per draft after a short quiet period and lists the discovered models inline for selection; changing the key or endpoint aborts a pending read and reads the new draft once. A failed read shows an inline notice with retry. The discovery dialog stays the searchable way to read or refresh the list. Discovery dialogs request a fresh server list on open and provide an explicit Refresh action. Search sits above the scrollable model list; the footer shows the total selection count, including models hidden by a filter. Select all applies only to matching models. A failed refresh shows an error with retry and clears the candidate list; it does not remove saved models. New API connections use the same settings editor after import. Subscription and API key cards render the same shared `ProviderCardContent`, and the API key Fetch models entry sits in the card header.

Model settings edit the display name, context window, maximum output tokens and text/image input types. The editor displays resolved values immediately, including inherited image support, with text/image choices always visible. Saving unchanged values preserves inheritance; clearing optional text or token fields removes their overrides. New connection drafts are written only when the connection is saved; settings for an existing model have their own confirmation. Cancelling either dialog leaves its settings unchanged.

While a model test runs, its play icon becomes a spinner and that row’s actions are disabled. Other model rows remain available. Successful test results stay beside the model; test and removal failures appear in app-wide toasts that remain visible after closing settings. Concurrent failures are shown in order.

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
- Saving newly enabled VVCode groups creates or reuses a Hemi-specific calling key after confirmation without a separate quota or expiry; account balance and group permissions still apply. Hemi refuses calls after the account authorization token (PAT) expires, but the remote model key does not expire with that PAT or become invalid when the local connection is disconnected. Manage remote authorization through the VVCode website or an administrator.

### Dev Note

None.
