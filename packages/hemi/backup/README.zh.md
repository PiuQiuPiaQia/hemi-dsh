---
description: "Harness 主目录与共享技能的快照备份：本地或 WebDAV 归档、保留清理与分阶段合并恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-backup

[English](README.md) | 中文

## Summary

`dsh-hemi-backup` 是宿主侧的 Hemi 备份编排服务。它对两个用户数据根做快照——Harness 主目录（`~/.dsh`：凭据、会话、存储、记忆、profile 组合清单）与共享 agent 根（`~/.agents/skills`）——打包为按体积分卷、逐卷 sha256 校验的 ustar+gzip 归档，写入本地文件夹或 WebDAV 目标（坚果云），按保留份数清理旧备份；恢复时先落暂存区并给出逐文件合并预估，再合并：新文件落位、相同文件跳过、冲突保留较新一方并把落选方移入安全副本目录。收集体积超过阈值（默认 5 MB）的技能目录整目录跳过，并记录进 manifest 的 `skipped` 清单。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Client interface](#client-interface)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

本包以 root 作用域 `hemi-backup` 条目接进 web-app bundle，无需按 profile 配置。唯一可调项是技能体积阈值：

```yaml
# cordis.patch.yml overlay
- id: hemi-backup
  name: '@deepseek-ai/dsh-hemi-backup'
  config:
    skillMaxBytes: 5242880
```

备份目标、定时与保留份数是服务持有的用户设置（落盘于 `~/.dsh/backup-settings.json`），通过 `dsh-hemi-backup-ui` 设置面编辑，不走 cordis.yml。

<a id="understand-the-implementation"></a>
## Understand the implementation

- `src/engine.ts` —— 双根白名单收集（归档路径带 `dsh/`、`agents/` 根标签前缀）、流式 ustar+gzip 打包（逐卷 sha256、GNU 长名支持）、增量解包器，以及合并与预估共用的逐文件恢复判定（`decideRestoreAction`）。快照防御把收集后的追加按收集尺寸截断、文件中途变短则失败；两个方向都不跟随符号链接。
- `src/webdav.ts` —— 编排所需的 WebDAV 操作（MKCOL/PUT/PROPFIND/DELETE/GET），基于 `fetch`，带类型化的 `AUTH_FAILED` / `NOT_FOUND` / `REQUEST_FAILED` 失败。
- `src/service.ts` —— `hemiBackup` Remote 命名空间：`getState`、`saveSettings`、`testConnection`、`runNow`、`listBackups`、`deleteSet`、`restorePrepare`、`restoreApply`、`restoreCancel`。WebDAV 应用密码经凭据服务存储（`HEMI_BACKUP_WEBDAV_PASSWORD`），绝不进设置文件；每小时一次 tick 判断定时是否到期。

<a id="client-interface"></a>
## Client interface

`./client` 导出客户端安全的视图类型（`BackupStateView`、`BackupSetView`、`RestorePreview` 及各操作结果）；`./remote` 携带 `dsh-hemi-backup-ui` 使用的生成版 Typert 客户端面。

<a id="known-limitations-and-deferred-work"></a>
## Known limitations and deferred work

- 归档不加密，凭据随包；云端目标保存的是明文等价物，设置面如实说明。
- 恢复在重启应用后完全生效；profile 组合清单随包恢复，`node_modules` 由插件管理器重装。
- 尚无空闲判定：定时备份在会话写入时依赖打包器的快照防御。
