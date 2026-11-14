---
description: "Enable same-Wi-Fi iPhone access to the current Hemi desktop and confirm pairing and manage device access."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-mobile-access-ui

English | [中文](README.zh.md)

## Summary

Connect an iPhone on the same Wi-Fi to the current Hemi desktop, then approve or reject its pairing request. Compare the six-digit code on both devices before allowing access to conversations, task execution, and files. Revoke a paired device or turn off the phone entry point without stopping running Agent tasks. Pairing content is single-use, expires after two minutes, and is encoded locally rather than sent to a QR service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open **Settings → Phone connection** on the computer. Enable the connection without choosing a network or entering an IP address. If Wi-Fi is unavailable, connect this computer to Wi-Fi and use Retry. Scan the QR code in Hemi on the iPhone, or copy the pairing content into the phone's pairing screen. Compare the phone and computer codes, then select **Codes match, allow connection** only if the codes match and you trust that phone. The copy button and JSON are together under **Pair manually**.

The page shows one current, unexpired confirmation while phone connection is on, plus paired devices with a revoke action. Empty device cards and settled request history are omitted. The confirmation replaces the claimed QR code and its generation controls; after expiry, generate a new invitation explicitly. Turning off phone connection retains device pairings and running Agent tasks. A failed operation retains the list and any still-valid invitation, reports unconfirmed outcomes explicitly, and offers refresh instead of claiming success. Expired or claimed invitations are not displayed as scannable QR codes.

In the connected Hemi iPhone app, open **Settings → Phone connection** to see the computer name and disconnect. Disconnect dispatches native teardown once and retains the pairing; an unknown result shows a short notice rather than retrying. This view does not read the desktop management resource or show pairing QR codes, network addresses, or device administration.

This optional browser contribution requires the mobile-access Host service and the shared settings, locale, Remote, and resource services. It has no configuration fields and never starts a listener when it mounts. Ordinary browsers without the native capability retain desktop management behavior, including desktop-only guidance after Host authorization denial.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser entry mounts the Host-generated `hemiMobileAccess` namespace before registering a `settings.section` contribution. Client Remote method types come from `TypertClientRemote`, while the Host's type-only entry owns state and opaque IDs. The controller exposes a resource that polls only while the settings section holds it, aborts reads and admitted actions when that holder closes, and joins requests before removing the namespace. Commands publish only authoritative Host results; stop and revoke also check the returned listener or device facts.

The native shell injects a frozen, versioned `window.__HEMI_MOBILE__` capability at main-frame document start. The client projects only its computer name and disconnect callback into slot inputs; native and desktop sections have separate hooks. The native shell owns main-frame/chosen-origin guards and teardown, and exposes no token, secret, or origin through this capability.

The desktop component receives the resource hook and narrow actions through standard slot injection. Only the explicit invitation-creation result carries a token; that result stays in mounted component state and is discarded on remount. The safe `getState` invitation view cannot reconstruct its QR code. The maintained `qrcode-generator` library encodes the complete invitation JSON in the browser, and the copy and manual paths use the same JSON. A local expiry timer removes invalid invitations even when a refresh fails; it performs no business reads.

Scoped tests cover interaction gating, bilingual copy, retained state on failure, authoritative command outcomes, polling cancellation, late command completion, and reversible registration. Rendered production-page and real-iPhone verification belong to the integrating composition; component fixtures do not establish that verification.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Mobile Host types](../mobile-access/src/types.ts) — invitation and management fields.
- [Client resources](../../../docs/subsystems/client-resources.md) — holder-owned streams.
- [Client slots](../../../docs/subsystems/slots.md) — injected presentation inputs.

-----

<a id="model-experience"></a>
## Model Experience

### `hemiMobileAccess` controls

#### What the model sees

The `hemiMobileAccess` settings controls add no model-visible tools, prompts, or messages.

#### Token effect

The page sends no model requests.

#### KV Cache effect

The page does not change model request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This page manages the current desktop Host only.

- Phone pairing requires the same local network and a compatible Hemi phone client; there is no public relay or separate bot runtime.
- Leaving the section discards its one-time invitation token. Generate a new invitation after reopening; paired devices remain on the Host.
- Host restart clears short-lived requests; the Host owns durable device records. The page does not display settled requests.

<a id="dev-note"></a>
### Dev Note

None.
