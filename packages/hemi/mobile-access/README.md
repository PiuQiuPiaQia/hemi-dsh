---
description: "Connect a paired iPhone on the same home LAN to this Hemi desktop host over TLS."
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-mobile-access

English | [中文](README.zh.md)

## Summary

Let a paired phone use this desktop's Hemi host on the same home network. Enabling access automatically binds available private IPv4 addresses; no user selects an address. A one-time invitation carries the connection candidates and pinned certificate, and the owner compares a six-digit code before approval. Approved phones use independent owner Peers through the existing `/api` bridge and Remote mux. Revocation closes their connections without stopping accepted host-side agent work.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Hemi Desktop composes this service with the mobile-access settings UI. Access stays off until the owner enables it. `start` takes no network address: the Host enumerates candidates and binds them on one shared port. The last primary address and port are persisted; later starts re-enumerate addresses and reuse the port. A port conflict fails visibly rather than silently moving the service.

Bind addresses come from the host's current interfaces: concrete non-internal IPv4 addresses in private (RFC1918) or link-local ranges only. Public and wildcard addresses are refused. The certificate is generated in-process (IP SANs, `serverAuth`, SHA-256) and reused across restarts; the invitation carries its SHA-256 fingerprint and the phone pins it.

Pairing is one invitation at a time: a 120-second one-time token transferred by QR or copy, one claiming phone, and one approval dialog where the owner compares the code shown on both screens. Device secrets exist only on the phone and as a hash in the DSH credential store; management state never returns a token or a hash.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `port` | `0` | Listener port. `0` asks the OS once, then the assigned port is persisted and reused; an explicit port always wins. |
| `serverName` | machine hostname | Name shown to phones in pairing and session responses. |
| `invitationTtlSeconds` | `120` | One-time invitation lifetime. |
| `requestTtlSeconds` | `300` | Pending pairing-claim lifetime. |
| `maxPairBodyBytes` | `8192` | Pair-endpoint JSON body cap. |
| `pairRequestsPerMinute` | `20` | Pair-endpoint events per remote address per minute. |
| `maxDevices` | `10` | Approved-device directory cap. |
| `maxApiBodyBytes` | `67108864` | Buffered `/api` request-body cap forwarded to the shared bridge. |

<a id="understand-the-implementation"></a>
## Understand the implementation

The service owns one lifecycle transaction: start, stop, and disposal serialize on one chain. Each concrete-address listener belongs to one group generation; requests return 503 until binding and durable-port persistence commit. Stop retires admission synchronously and joins all resource cleanup. Phone traffic enters a group member that applies a Host/Origin/cross-site fence, rate-limits the public pairing endpoints, authenticates devices by constant-time secret-hash comparison, and forwards admitted traffic to existing seams — `/api` through the Connection bridge and its shared admission waterfall, other GET/HEAD reads through the webServer's registered resources with the device's own Peer, and the single `/api/remote.mux` WebSocket upgrade through the Gateway's mux. Credential-store changes invalidate a generation-fenced cache, re-read storage, and retire live Peers whose device record disappeared or whose secret hash rotated.

<details>
<summary>Pairing and device records</summary>

A pairing approval reserves its request row, writes the device record (id, name, creation time, secret hash) durably, and only then publishes `approved`; a failed or raced write releases the row and withdraws the record. TLS material, the device directory, and the last listener facts each live in one credential grant record under this plugin's scope, validated against a strict schema so a damaged record fails visibly instead of reading as absent or empty.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Connection HTTP bridge](../../client/connection/README.md) — shared `/api` admission and the request waterfall every phone request passes.
- [Typert Gateway](../../api/gateway/README.md) — the Remote mux the phone's WebSocket joins.
- [Credential seam](../../credentials/credentials/README.md) — grant records that hold the device directory, TLS material, and listener facts.

<a id="model-experience"></a>
## Model Experience

### Phone-driven sessions

#### What the model sees

No new prompt section, tool schema, or Session event. A paired phone's requests arrive as ordinary owner Peer calls through the existing `/api` bridge, so the model sees exactly the session traffic any owner client produces.

#### Token effect

None beyond the requests themselves: pairing, the TLS listener, and the device directory never enter a prompt.

#### KV Cache effect

The package does not touch request prefixes. A phone-driven Session reuses provider cache on the same terms as the desktop client driving the same Session.

## Known Limitations and Deferred Work

- Invitations optionally carry up to 32 same-port `origins`, primary first. Phones probe them without credentials and select one reachable pinned origin before a single pair POST. Interface changes require turning access off and on again; a new certificate still requires a fresh invitation. No mDNS, cloud relay, or silent certificate trust.
- One invitation lives at a time; a pending claim cannot be cancelled from the host — the phone stops polling and the claim expires by TTL.
- Approved phones have full owner task and file authority. Desktop-only management RPC is not a sandbox against actions an owner can instruct the agent to perform; approve only trusted devices.
- The Loader-level composed test in this package covers the host side only; full browser-driven pairing runs in the desktop application's own test lane.
- Pairing requests are in-memory by design; a host restart clears them, while approved devices persist.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
