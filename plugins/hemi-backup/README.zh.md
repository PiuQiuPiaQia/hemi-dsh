---
description: "以独立 config-only 层把 Hemi 数据备份装进 dsh profile：从本仓库打包三个 tgz，用 profile 插件命令一次加入，避开已内置备份行的组合。"
kind: "package-bundle"
---

# @hemi/backup

[English](README.md) | 中文

## Summary

`@hemi/backup` 是安装 Hemi 数据备份的 config-only profile 层：`cordis.patch.yml` 插入备份行，包本身不含代码。把它和两个备份包一起打成三个 tgz，用 `dsh plugin --profile <name> add` 一次加入 profile。备份行为——双根快照归档、本地或 WebDAV 目标、带保留策略的定时备份、分阶段合并恢复——属于那两个包。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

从完成 workspace 构建的本仓库 checkout 打包安装，这样两个备份包带有 `pack.mjs` 校验的 `lib/` 产物。

```text
pnpm install && pnpm run build
node plugins/hemi-backup/pack.mjs <destination>
```

`pack.mjs` 把 `@deepseek-ai/dsh-hemi-backup`、`@deepseek-ai/dsh-hemi-backup-ui`、`@hemi/backup` 打进 `<destination>`（默认 `dist/`），并写 `packages.json` 记录每个包的文件名、版本和 SHA-256。

一条 profile 插件命令加入全部三个包——标准入口会把参数原样转发给 profile 目录内的 pnpm：

```text
dsh plugin --profile <name> add \
  <destination>/deepseek-ai-dsh-hemi-backup-<version>.tgz \
  <destination>/deepseek-ai-dsh-hemi-backup-ui-<version>.tgz \
  <destination>/hemi-backup-<version>.tgz
```

准确文件名读 `<destination>/packages.json`。`@hemi/backup` 以匹配版本声明两个备份包为 peer 依赖；一条命令加入三个包即可满足。

只装在不含内置 Hemi 备份行的组合上：本仓库的 web-app bundle 已接线 `hemi-backup` 与 `hemi-backup-ui`，再叠加本层会重复插行。由官方上游 bundle 组成的 profile 没有这些行。

### Verify the installation

真实 profile 安装冒烟在干净的官方组合上跑完整链路——安装、宿主启动、设置面、本地目标备份、合并恢复、重启：

```text
node plugins/hemi-backup/tests/installed-smoke.mjs
```

缺 Playwright 内置浏览器时设 `HEMI_BACKUP_BROWSER_CHANNEL=chrome` 复用系统 Chrome。

<a id="understand-the-implementation"></a>
## Understand the implementation

`cordis.patch.yml` 插入两行：`hemi-backup`（持有 `hemiBackup` Remote 命名空间的宿主服务）和 `hemi-backup-ui`（浏览器设置面）。包的 `dsh.bundle.patch` 声明是 profile 插件管理器安装后读取的依据，行由此进入 profile 组合，不改 `cordis.yml`。

<a id="further-exploration"></a>
## Further Exploration

- `packages/hemi/backup` —— 快照引擎、WebDAV 客户端与编排服务。
- `packages/hemi/backup-ui` —— 挂在 `hemiBackup` 命名空间上的设置面。
- `plugins/hemi-model-routing` —— Hemi 模型路由的同款可安装层。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- 冒烟用 pnpm 走 registry 安装；完全离线安装需要预热过的 store。
- WebDAV 目标仅由单元级约定覆盖；冒烟驱动的是本地文件夹目标。
