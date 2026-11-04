---
description: "Hemi 人物皮肤主题：别名 token 调色板；供维护者移植 Hemi 皮肤表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-hemi-skins

[English](README.md) | 中文

## 概述

把 Hemi 桌面助手的六套皮肤（经典加五套人物皮肤）注册为可选别名 token 主题，通过持久化的 `overrideTokens` 覆盖层应用所选皮肤，并把移植的人物背景图渲染为固定背景层，同时展示各皮肤的题字。内置主题偏好 schema 只接受 light/dark/system，第三方 id 的 `setTheme` 会被下一次设置 adopt 打回；覆盖层让皮肤在偏好切换下持续生效。待机动画与头像延期。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## 使用此包

web-app bundle 在 `dsh-client-ui-theme` 之后挂载本插件，因此 `ctx.theme` 可用。每个 `ThemeDefinition` 的 id 都可作为后续选择器的 `setTheme` 参数。

<a id="understand-the-implementation"></a>
## 理解实现

`src/client/skins.ts` 把 Hemi `skins.config.json` 调色板表（rail、accent、scale-600、line）映射为一小组 `--dsw-alias-*` token。客户端半部逐个注册皮肤，并在卸载时撤销注册。

<a id="further-exploration"></a>
## 进一步探索

- `packages/client/ui-theme` 拥有主题注册表、token 样式表与设置行。
- Hemi 源表位于 Hemi 仓库 `src/shared/appearance/skins.config.json`。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

在皮肤选择行交付前，启动时应用会覆盖已持久化的偏好。背景图、头像、待机动画与题字延期。

<a id="dev-note"></a>
## 开发备注

fork 新增；调色板表需与 Hemi 源保持同步。
