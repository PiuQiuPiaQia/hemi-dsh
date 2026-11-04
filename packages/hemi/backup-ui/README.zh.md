---
description: "Hemi 数据备份设置面：目标编辑、连接测试、手动与定时备份、备份集列表和分阶段恢复对话框。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-backup-ui

[English](README.md) | 中文

## Summary

`dsh-hemi-backup-ui` 在通用设置页渲染 Hemi 备份卡片：上次备份状态、目标编辑（本地文件夹或 WebDAV/坚果云应用密码）、连接测试、立即备份、定时与保留份数控制、带恢复与删除的备份集列表，以及应用前展示合并预估（新增/相同/冲突）的分阶段恢复对话框。所有动作调用由 `dsh-hemi-backup` 持有的 `hemiBackup` Remote 命名空间。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

本包以浏览器 `hemi-backup-ui` 条目接进 web-app bundle；要求宿主侧存在 `dsh-hemi-backup`，自身无需配置。

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/client/index.ts` 注册 `hemi-backup` locale 命名空间并把 `BackupSection` 注入 `settings.general.item` 槽位；注入面负责拆开宿主方法外的 Remote 结果封套。`BackupSection.tsx` 持有编辑器状态、单飞忙碌守卫、运行中的进度轮询，并在卸载时取消任何已暂存的恢复。

<a id="known-limitations-and-deferred-work"></a>
## Known limitations and deferred work

- 没有首跑恢复向导；恢复一律从设置页发起。
- 本地文件夹目标是手输路径；桌面端暂无原生目录选择器。
