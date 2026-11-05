---
description: "Harness 主目录与共享技能的快照备份：本地或 WebDAV 归档、保留清理与分阶段合并恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-backup

[English](README.md) | 中文

## 概述

将 Harness 主目录与共享 agent 技能备份到本地文件夹或 WebDAV，支持分卷哈希校验与保留清理。恢复前先预览合并结果：添加新文件、跳过相同文件，已有会话保留本地代际，其他冲突保留较新副本并将另一份保存到安全副本目录。超大技能目录被跳过并列入清单。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Client interface](#client-interface)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

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
## 理解实现

- `src/engine.ts` —— 双根白名单收集（归档路径带 `dsh/`、`agents/` 根标签前缀）、流式 ustar+gzip 打包（逐卷 sha256、GNU 长名支持）、增量解包器，以及合并与预估共用的逐文件恢复判定（`decideRestoreAction`）。快照防御把收集后的追加按收集尺寸截断、文件中途变短则失败；两个方向都不跟随符号链接。
- `src/webdav.ts` —— 编排所需的 WebDAV 操作（MKCOL/PUT/PROPFIND/DELETE/GET），基于 `fetch`，带类型化的 `AUTH_FAILED` / `NOT_FOUND` / `REQUEST_FAILED` 失败。
- `src/service.ts` —— `hemiBackup` Remote 命名空间：`getState`、`saveSettings`、`testConnection`、`runNow`、`listBackups`、`deleteSet`、`restorePrepare`、`restoreApply`、`restoreCancel`。WebDAV 应用密码经凭据服务存储（`HEMI_BACKUP_WEBDAV_PASSWORD`），绝不进设置文件；每小时一次 tick 判断定时是否到期。

恢复不会替换、重命名或删除已有 Session 目录内的文件，也不会向其中增加其他代际。相同的备份文件跳过，不同或额外的备份代际存入 `restore-safety/restore-*/dsh/sessions/`。缺失的 Session 目录通过排他文件发布恢复，避免覆盖并发写入方的文件。其他数据沿用逐文件合并策略。合并失败可能已完成部分操作；重试前请保留原备份与报告中的安全副本目录。

收集范围包括 `$DSH_HOME/hemi-memory/`（`MEMORY.md`、`daily/`、`SCRATCHPAD.md`）和旧 `memory/` 目录。已有归档仍可读取，但尚未收集 Hemi 记忆的旧归档无法恢复遗漏文件；迁移机器前请重新备份。

在本地读取或 WebDAV 下载前校验 manifest 字段与分卷文件名。解压名称（含 GNU 长名）必须是收集白名单内的相对路径；拒绝目录穿越、绝对路径、Windows 别名、链接、重复文件和不完整 tar 流。源文件读取、压缩或输出失败会使备份失败，并清理未完成的备份集；打包失败不会上传或清理旧备份。

<a id="client-interface"></a>
## 客户端接口

`./client` 导出客户端安全的视图类型（`BackupStateView`、`BackupSetView`、`RestorePreview` 及各操作结果）；`./remote` 携带 `dsh-hemi-backup-ui` 使用的生成版 Typert 客户端面。

## 模型体验

<a id="model-experience"></a>

### 备份与恢复

#### 模型看到的内容

归档操作不注册模型输入或工具；恢复的 `Session` 文件保留记录内容。

#### Token 影响

归档操作不消耗模型 token。

#### KV Cache 影响

备份保留请求前缀；恢复不同的 Session 历史可能改变后续请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 归档不加密，凭据随包；云端目标保存的是明文等价物，设置面如实说明。
- 恢复在重启应用后完全生效；profile 组合清单随包恢复，`node_modules` 由插件管理器重装。
- 尚无空闲判定：定时备份在会话写入时依赖打包器的快照防御。

### 开发备注

<a id="dev-note"></a>

无。
