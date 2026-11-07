# Hemi-DSH

English | [中文](README.zh.md)

<img src="packages/hemi/customizations/artwork/icon-macos.png" alt="Hemi app icon" width="88">

Hemi-DSH is an open-source desktop AI agent built on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Connect your models, assign them to task roles, and keep memory across sessions.

[Download Hemi Desktop](https://github.com/PiuQiuPiaQia/hemi-dsh/releases)

## Download

Open [GitHub Releases](https://github.com/PiuQiuPiaQia/hemi-dsh/releases) and choose the newest nightly. The published desktop builds are for macOS on Apple Silicon. Download the installer ending in `-mac-arm64.dmg` from the release assets.

Hemi-DSH is in developer preview. Read the [safety notice](SAFETY.md) before use.

## Features

- **Model connections** support subscription accounts, API keys, and New API sites. Sign in to a New API site inside the desktop app, select models from the list, and import them in one step. [Model connections guide](packages/hemi/model-access-ui/README.md)
- **Model routing** lets you choose a main model and assign models to research, review, execution, and design roles. [Model routing guide](packages/hemi/routing-ui/README.md)
- **Memory** carries context across sessions. Edit long-term memory, daily logs, and notes in Settings. [Memory guide](packages/hemi/memory-ui/README.md)
- **Backup and restore** supports local folders and WebDAV. Preview how a backup will merge with local data before restoring it. [Backup guide](packages/hemi/backup-ui/README.md)

## Run

For the Web UI, follow [Run from source](#run-from-source), then open the URL printed by the launcher. [Web UI guide](docs/user/guide/index.md)

### Run from source

Clone [this repository](https://github.com/PiuQiuPiaQia/hemi-dsh) and follow the [development guide](docs/development.md) to install dependencies, build, and launch Web or Desktop from your checkout.

## Development

Hemi features live in [Hemi plugins and desktop adapters](packages/hemi/README.md). See the [DSH architecture](docs/architecture.md) for the runtime, and [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for repository conventions.

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses.
