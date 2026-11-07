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

The Desktop profile hides the native Account and Models tabs and the sidebar account menu; account controls remain in Model connections. The Subscription and API tabs support arrow keys, Home and End. Connect New API opens a dialog in the API tab. On desktop, the site protocol defaults to HTTPS. Select HTTP for a trusted self-hosted site that requires it. Sign in inside the dialog, then select I’ve signed in, continue. The only available token group opens automatically; if several groups are available, choose one. Check the models and select Import models. The app creates the token, verifies the models and saves the connection. Closing the dialog preserves drafts and does not cancel the native import; its progress or outcome remains visible in the API tab. If the dialog cannot read the import status, it retries and clears the warning once status is available. Successful imports refresh the connection list. Select Done to dismiss the result. Open Connect New API again to enter a new site. Without the desktop bridge, the dialog imports an existing token.

All accounts in the Subscription tab use the same `SubscriptionCard` component. DeepSeek shares native sign-in and account state through `account.connection`, with topped-up and granted balances in place of quota bars. Login loads the native `deepseek-account` catalog automatically; the shared model rows provide settings and connection tests. Model removal and the searchable Fetch models dialog use the same controls as other subscriptions. The Fetch models icon sits before the reconnect action in each connected subscription header, with a localized tooltip. The native provider persists `selectedModels`, including an explicit empty list, while discovery reloads every serviceable candidate for adding models back. Quota and balance refresh use the same icon button, with localized tooltips and a disabled state while refreshing. Balance refresh and sign-out use native account operations, including confirmation of running-task impact.

Key presets supply connection addresses without injecting model IDs. Discover or enter model IDs before saving a connection. Discovery dialogs request a fresh server list on open and provide an explicit Refresh action. Search sits above the scrollable model list; the footer shows the total selection count, including models hidden by a filter. Select all applies only to matching models. A failed refresh shows an error with retry and clears the candidate list; it does not remove saved models. New API connections use the same settings editor after import. Subscription and API key cards render the same shared `ProviderCardContent`, and the API key Fetch models entry sits in the card header.

Model settings edit the display name, context window, maximum output tokens and text/image input types. The editor displays resolved values immediately, including inherited image support, with text/image choices always visible. Saving unchanged values preserves inheritance; clearing optional text or token fields removes their overrides. New connection drafts are written only when the connection is saved; settings for an existing model have their own confirmation. Cancelling either dialog leaves its settings unchanged.

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
