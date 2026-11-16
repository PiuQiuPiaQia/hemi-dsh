# Agent Note: Third-party phone access

Status: implemented

English | [中文](2026-11-14-third-party-phone-access.zh.md)

## Problem

Phone access needs a secure path to the existing desktop Host without duplicating Sessions or agent state. The [self-owned companion decision](../../archived/architecture/2026-11-12-samehost-phone-companion-authorization.md) adds a separate pairing protocol, TLS listener, device directory, settings page, and iOS application to maintain. The user uses dsh-pocket and chooses that plugin instead of maintaining the companion.

## Decision

Hemi does not ship its own phone-access service or iOS companion. Third-party plugins own their phone clients, authentication, and network tunnels. Hemi retains the native Web HTTP and WebSocket routes, browser authentication, and general transport hooks used by Desktop and other current consumers.

Hemi Desktop preinstalls the original third-party bundles through its [profile adapter](../../../../packages/hemi/customizations/README.md#preinstalled-plugins), without restoring the self-owned implementation. It does not transfer pairings, delete stored credentials, or modify plugin preferences. Existing Sessions and Workspaces remain owned by their original services.

## Alternatives considered

- **Keep both implementations.** This retains two phone-access paths and the self-owned protocol and client maintenance that the user declines.
- **Add external-network support to the companion.** This extends the same maintenance responsibility rather than using the user's working plugin.

## Consequences

Hemi gives up its built-in per-device pairing and revocation UI and pinned-TLS iOS companion. Remote-access security and compatibility require separate review for each selected plugin; removing Hemi's service does not establish a third-party plugin's safety. A self-owned implementation needs a new demonstrated requirement that supported third-party options cannot meet.

## Testing

The Desktop startup scenario rejects the removed Loader entries and phone settings section. Connection and Gateway regressions cover the retained Web routes. Generated catalogs and documentation checks reject stale package references; browser verification records the settings navigation without the companion entry.
