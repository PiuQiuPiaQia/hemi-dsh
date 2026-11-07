---
description: "Publish Hemi Desktop through GitHub using a fixed Mac self-signed certificate and unsigned Windows installers."
---

# Hemi Desktop GitHub releases

English | [中文](README.zh.md)

## Summary

The [GitHub workflow](../../../../.github/workflows/hemi-desktop-release.yml) defaults to `community`: macOS uses the existing fixed Hemi self-signed certificate, and Windows produces unsigned NSIS installers. The installed application is named Hemi and new artifacts retain the `hemi-dsh` prefix; the external protocol is `hemi-dsh://open`. [Identity migration](../../../../docs/upgrade-guide/v0.2.2-alpha.3/hemi-desktop-identity/guide.md) explains the independent default data directories and first renamed installation. Both retain DSH's generic updater, channel selection, task-stop confirmation and native installation. Releases contain versioned files; a dedicated public branch contains platform-specific update feeds. The `official` option retains DSH's Developer ID/notarization and Windows EV requirements.

## Table of Contents

- [Configure community releases](#configure-community-releases)
- [Signing and installation](#signing-and-installation)
- [Select and publish a version](#select-and-publish-a-version)
- [Feeds and compatibility](#feeds-and-compatibility)
- [Failures and recovery](#failures-and-recovery)
- [Verification](#verification)

<a id="configure-community-releases"></a>

## Configure community releases

Use the public fork containing the source commit. The workflow publishes into its own `github.repository`. Applications contain no publishing token. On the fork, configure these Actions secrets with the same identity used by the original Hemi build:

| Secret | Value |
| --- | --- |
| `HEMI_MAC_SIGNING_P12` | Base64 of the existing fixed certificate's p12 archive |
| `HEMI_MAC_SIGNING_PASSWORD` | Its export password; CI dotenv encoding rejects line breaks, NUL and single quotes |

The source includes only Hemi's public certificate. Missing secrets, an unavailable private key or a mismatched certificate stop Mac packaging; the workflow never generates a replacement or falls back to ad-hoc signing. Private inputs are written only to an owned temporary hosted-runner directory and removed after packaging. The scoped keychain is deleted after its child operations settle, with the previous user search list restored. Certificate trust settings are not changed. Windows needs neither secret.

Community builds use GitHub-hosted `macos-15` for arm64, `macos-15-intel` for x64 and `windows-latest` for Windows. They require no self-hosted runner configuration or Apple notarization credentials. Optional repository variables are `HEMI_DESKTOP_APP_ID` (default `ai.hemi.dsh.desktop`), `HEMI_DESKTOP_FEED_BRANCH` (default `desktop-update-feeds`) and `HEMI_DESKTOP_RELEASE_TARGETS` (`mac-arm64`, `mac-all`, `win-x64` or `all`; default `mac-arm64`). Preserve the application ID of existing DSH fork installations when preparing their upgrades.

Configure the `hemi-desktop-production` GitHub Environment for release operators. Its protection settings control the publication job. Only that job receives contents write permission. Branch and tag rules must permit its dedicated feed branch and release tags; the tooling does not alter repository permissions.

For a local build, use [production.env.example](production.env.example) as `presets/production.env` in a separate configuration directory. Mac's `secrets/macos-signing.env` supplies `CSC_LINK` and `CSC_KEY_PASSWORD` for the same certificate. Set `DSH_PACKAGING_PRESET=production` and `DSH_PACKAGING_CONFIG_DIR` to that absolute directory. The platform dotenv files accept the same public fields. Parent-process Hemi distribution settings cannot redirect file-owned packaging.

Selecting `official` uses the existing signing-machine path. It requires `HEMI_DESKTOP_MAC_CONFIG_DIR` or `HEMI_DESKTOP_WINDOWS_CONFIG_DIR` for selected targets, with optional runner labels `HEMI_DESKTOP_MAC_RUNNER` and `HEMI_DESKTOP_WINDOWS_RUNNER`. Follow [Desktop packaging](../../../../apps/desktop/packaging/README.md) for its certificate, notarization and EV setup. A tag-triggered workflow can select this mode through the `HEMI_DESKTOP_SIGNING_MODE` repository variable; otherwise it uses `community`.

<a id="signing-and-installation"></a>

## Signing and installation

The local public preset explicitly selects `HEMI_DESKTOP_SIGNING_MODE=community`, a GitHub repository, `DSH_DESKTOP_AUTO_UPDATE_ENV=production`, and optionally `HEMI_DESKTOP_UPDATE_POLICY=disabled`. Omitted signing mode preserves normal DSH requirements. The updater channels `stable` and `nightly` remain independent of these signing choices. COS upload commands reject GitHub packages.

Mac packaging signs with the pinned certificate and verifies nested code, all architectures and the exact designated requirement: bundle identifier plus certificate fingerprint. The same certificate signs standalone native libraries and the bundled Node/Python runtime before their file inventories are sealed. Shared Desktop traversal retains architecture-specific JIT entitlements, verified Python aliases and sealed helper bundles. Self-signed native code also carries the [library-validation exception](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation), because these certificates have no Apple Team ID for loading native libraries. It requests neither a timestamp service nor Apple notarization. Computer Use helpers for both architectures use the same certificate, validated native receipts and the same signature checks. This does not create the official notarized helper manifest used for npm publication. First macOS permission grants remain manual; equal signatures alone do not establish permission retention.

The fixed designated requirement permits Squirrel.Mac to validate subsequent builds signed by the same identity. The native updater remains in use. No application swap script or system trust-store exception is installed. These builds have no Apple notarization ticket; first installation/opening remains subject to macOS security approval. Moving an existing ad-hoc or differently signed installation to this identity requires a separately qualified manual installation before relying on updates.

Windows community packages have no Authenticode publisher signature. Their updater explicitly omits publisher-signature verification and retains SHA-512 payload verification and DSH's separate installation authorization. Release/feed write access controls this distribution. Windows may show an unknown-publisher warning. Official Windows verification is unchanged.

<a id="select-and-publish-a-version"></a>

## Select and publish a version

Run **Release Hemi Desktop · GitHub** manually, choosing a full build version, channel, target group and signing mode. Alternatively, push `hemi-desktop-v<version>`; a plain version selects `stable`, and a prerelease selects `nightly`. Versions follow the [existing build-version rules](../../../../apps/desktop/packaging/README.md#release-versions). Stable requires a stable product version. COS-backed automatic version discovery is not used.

All selected targets use the same frozen source commit and version. Packaging never publishes. A single publisher checks completion records, clean-source identity, signing mode, the pinned Mac certificate, update URL, size and SHA-512. It creates `hemi-desktop-<channel>-v<version>`, generates release notes, resumes a matching draft and verifies GitHub's reported asset SHA-256/size. It publishes the Release before advancing all selected feeds in one non-forced Git commit. Keep the `Hemi Desktop package:` marker line when editing notes so retries can identify the package.

For downloaded artifacts, `pnpm --dir apps/desktop run github:release preview --signing-mode community --artifacts <directory> --version <version> --channel <channel> --targets <targets> --repository <owner/repo> --commit <source-sha>` writes a local `release-plan.json` without network access. The directory contains one subdirectory per target. `publish` accepts the same selection and requires `GH_TOKEN`; Actions supplies its scoped token only to publication. Select `--signing-mode official` for ordinary DSH-signed records. The publisher rejects mixed modes and changed Mac certificate pins.

<a id="feeds-and-compatibility"></a>

## Feeds and compatibility

The embedded URL is `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/feeds/<target>/`. Windows uses `stable.yml` / `nightly.yml`; macOS uses `stable-mac.yml` / `nightly-mac.yml`. Each file contains absolute, version-pinned Release URLs and SHA-512 checksums. Independent architecture directories allow partial releases without overwriting another target or channel.

Clients read feeds without tokens or REST polling. A Release's prerelease flag does not select the client channel. DSH's higher-version-only rule, download approval, task-stop checks and installation confirmation remain active. A channel becomes available after its first publication. Changing repository, branch, application ID or certificate requires compatibility qualification; original Hemi data migration is outside this workflow.

Raw GitHub caching can delay visibility. Release operators qualify feed and binary access from supported user networks; an API-confirmed branch commit does not establish public CDN availability.

<a id="failures-and-recovery"></a>

## Failures and recovery

Rerun failed jobs within the same workflow run while package artifacts remain retained. Successful target artifacts are reused; their records must match source, version, destination and signing mode. Rebuilding an already published version can change bytes and is rejected on conflict.

HTTP operations have deadlines and no automatic retry. Failed or unknown uploads leave feeds unchanged; reruns reconcile matching remote assets by SHA-256. Published assets are never deleted or replaced. A failed feed write may leave a public Release not yet delivered to clients; a rerun finishes feed advancement. Unknown writes are reconciled by reading branch state. Higher feed versions, conflicting same-version content, invalid feeds, changed certificates or mismatched source tags stop publication. Concurrent branch movement fails a non-forced update rather than discarding unrelated feeds.

Inspect conflicts before retrying and use a higher version for changed packages. Do not rotate the fixed certificate, replace public assets, move source tags or force-push feeds to make a retry pass. Actions retains installers for 14 days and publication plans for 30 days; published installers remain Release attachments.

<a id="verification"></a>

## Verification

Unit tests cover both signing modes, owned credential cleanup, refusal paths, package hashes, real updater parsing and publication recovery. Run `pnpm exec vitest run apps/desktop/tests/hemi-community-signing.spec.ts apps/desktop/tests/hemi-github-update.spec.ts packages/hemi/customizations/tests/github-release.spec.ts`.

On macOS with Node 24 and installed workspace dependencies, `python3 apps/desktop/tests/fixtures/hemi-community-signing.py --native` creates only temporary certificates, keychains and Electron apps, signs changed builds through the production signer and checks actual Squirrel.Mac acceptance. It does not read the saved Hemi private key, add certificate trust or update an installed application. Run without concurrent keychain-list mutations.

The isolated qualification establishes certificate continuity and native update preparation. Release operators still qualify actual hosted-runner builds, GitHub permissions, first-open security behavior, final installation/restart, user-data retention and real Computer Use permission continuity. No production Release is created by local tests.
