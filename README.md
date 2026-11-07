# Hemi-DSH

English | [中文](README.zh.md)

<img src="packages/hemi/customizations/artwork/icon-macos.png" alt="Hemi app icon" width="88">

Hemi-DSH is an open-source desktop AI agent built on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) for people who want to choose their own models for research, coding, and design.

[Download Hemi Desktop](https://github.com/PiuQiuPiaQia/hemi-dsh/releases)

## Why Hemi-DSH

- **Use the models you already have.** Manage subscription accounts, API keys, and New API sites in one place. For New API, sign in inside Hemi, select models from the list, and import them in one step. [Model connections guide](packages/hemi/model-access-ui/README.md)
- **Give each role its own model.** Keep your preferred model for the main conversation and assign others to research, review, execution, or design. Switch between automatic routing and a fixed model per session. [Model routing guide](packages/hemi/routing-ui/README.md)
- **Pick up where you left off.** Hemi uses saved memory and daily logs as context for new sessions. You can read and edit that context in Settings. [Memory guide](packages/hemi/memory-ui/README.md)
- **Back up your work to a location you choose.** Save sessions and memory to a local folder or WebDAV, and preview how a backup will merge with local data before restoring it. [Backup guide](packages/hemi/backup-ui/README.md)

## Download

Open [GitHub Releases](https://github.com/PiuQiuPiaQia/hemi-dsh/releases) and choose the newest nightly. The published desktop builds are for macOS on Apple Silicon. Download the installer ending in `-mac-arm64.dmg` from the release assets.

Hemi-DSH is in developer preview. Read the [safety notice](SAFETY.md) before use.

## Run

For the Web UI, follow [Run from source](#run-from-source), then open the URL printed by the launcher. [Web UI guide](docs/user/guide/index.md)

### Run from source

Clone [this repository](https://github.com/PiuQiuPiaQia/hemi-dsh) and follow the [development guide](docs/development.md) to install dependencies, build, and launch Web or Desktop from your checkout.

## Development

Hemi features live in [Hemi plugins and desktop adapters](packages/hemi/README.md). See the [DSH architecture](docs/architecture.md) for the runtime, and [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for repository conventions.

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses.
