# Agent Note: Preinstalled third-party Desktop bundles

Status: implemented

English | [中文](2026-11-14-preinstalled-desktop-bundles.zh.md)

## Problem

The user chooses the original dsh-pocket and dsh-mnemon plugins instead of maintaining Hemi-owned phone and memory implementations, and wants Desktop installations to include them without a separate installation step. Startup must work offline, avoid duplicate bundle rows, and preserve existing configuration and disable decisions.

## Decision

The CLI manifest pins both original npm packages as installation dependencies. Their packages enter the existing production closure and remain unmodified. Only Desktop profile preparation selects their original bundle layers automatically. The pure-Node [Hemi adapter](../../../../packages/hemi/customizations/README.md#preinstalled-plugins) records handled bundle names and selections in one atomic profile-manifest write under the existing Desktop profile lock. A profile-installed but deselected package remains off; subsequent preparation and recovery do not re-enable handled bundles. User patches, credentials, dependency declarations, and plugin data remain intact.

Installation ownership keeps both bundles discoverable and switchable in Plugin Manager, without uninstall or independent version replacement. The installation's pinned copy takes precedence over any retained profile-local copy. Other CLI profiles carry the dependencies but do not enable these bundles automatically.

Pocket retains GPL-2.0. The user's explicit selection permits only that package-and-license pair in the notices check, not GPL generally. Desktop carries the unchanged license and matching complete upstream source archive, including client source and build scripts. Packaging verifies the archive digest and installed version before sealing the runtime. Mnemon retains MIT. Neither plugin is relabeled as Hemi code.

## Alternatives considered

- **Install on first launch.** This introduces network and package-manager failure into offline startup and duplicates existing runtime preparation.
- **Copy the upstream patch into Hemi's Web bundle.** This duplicates ownership, can collide with a separately selected bundle, and prevents ordinary per-bundle disable behavior.
- **Maintain self-owned replacements.** This restores the protocol and UI maintenance the user explicitly declines; the [phone removal decision](../simplification/2026-11-14-third-party-phone-access.md) retains that trade-off.

## Consequences

Hemi accepts the additional dependency size and release responsibility for both plugins. Bundled versions update with Hemi rather than independently. Pocket retains its upstream LAN and password behavior and saved tunnel preferences; a fresh installation starts no public tunnel. Mnemon uses its own storage and tools, with no automatic import of old Hemi memory files. Preinstallation is not a security certification of upstream code.

## Testing

Profile tests cover one-time selection, existing disabled installations, restart, recovery, malformed state, and preservation of user files. Source-distribution tests reject mismatched digests and versions. The real browser scenario loads both original bundles, reads recorded history, checks the public tunnel stays off, and verifies both manageable plugin cards.
