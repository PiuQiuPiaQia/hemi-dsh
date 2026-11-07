---
description: "Hemi 数据备份设置面：目标编辑、连接测试、手动与定时备份、备份集列表和分阶段恢复对话框。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-backup-ui

[English](README.md) | 中文

## 概述

`dsh-hemi-backup-ui` 在设置导航中注册独立的「备份」页：上次备份状态、目标编辑（本地文件夹或 WebDAV/坚果云应用密码）、连接测试、立即备份、定时与保留份数控制、带恢复与删除的备份集列表，以及应用前展示合并预估（新增/相同/冲突）的分阶段恢复对话框。所有动作调用由 `dsh-hemi-backup` 持有的 `hemiBackup` Remote 命名空间。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

本包以浏览器 `hemi-backup-ui` 条目接进 web-app bundle；要求宿主侧存在 `dsh-hemi-backup`，自身无需配置。

WebDAV 服务器地址预填为坚果云地址 `https://dav.jianguoyun.com/dav/`。已保存的 WebDAV 目标保留其配置地址；该字段仍可编辑。

<a id="understand-the-implementation"></a>
## 理解实现

`src/client/index.ts` 注册 `hemi-backup` locale 命名空间并把 `BackupSection` 注入 `settings.section` 槽位；注入面负责拆开宿主方法外的 Remote 结果封套。设置页组合 `dsh-client-ui-primitives` 的 `Button`、`Input`、`Switch` 公共控件；备份目标与定时选择保留原生 `select`。`BackupSection.tsx` 持有编辑器状态、单飞忙碌守卫、运行中的进度轮询，并在卸载时取消任何已暂存的恢复。

恢复确认区说明已有会话保持原样，冲突的会话备份另存安全副本。

## 模型体验

<a id="model-experience"></a>

### 备份操作

#### 模型看到的内容

`hemiBackup` 设置与恢复预览仅在用户界面呈现。

#### Token 影响

面板不发送模型请求。

#### KV Cache 影响

面板不修改请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 没有首跑恢复向导；恢复一律从设置页发起。
- 本地文件夹目标是手输路径；桌面端暂无原生目录选择器。

### 开发备注

<a id="dev-note"></a>

无。
