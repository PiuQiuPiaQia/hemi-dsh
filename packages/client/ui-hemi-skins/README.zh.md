---
description: "Hemi 人物皮肤主题：别名 token 调色板；供维护者移植 Hemi 皮肤表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-hemi-skins

[English](README.md) | 中文

## 概述

把 Hemi 桌面助手的六套皮肤（经典加五套人物皮肤）注册为可选别名 token 主题，通过持久化的 `overrideTokens` 覆盖层应用所选皮肤，并把移植的人物背景图渲染为不带题字的固定背景层。人物保持素材原始宽高比，沿用 Hemi 按高度构图的规则：高度 104%、右侧 -12%、底部 -13%；宽度不超过 880px 时，高度 90%、右侧 -40%、底部 -8%。内置主题偏好 schema 只接受 light/dark/system，第三方 id 的 `setTheme` 会被下一次设置 adopt 打回；覆盖层让皮肤在偏好切换下持续生效。待机动画与头像延期。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

web-app bundle 在 `dsh-client-ui-theme` 之后挂载本插件，因此 `ctx.theme` 可用。每个 `ThemeDefinition` 的 id 都可作为后续选择器的 `setTheme` 参数。皮肤设置页在标题下等宽展示六个预设，窄面板自动减少列数。当前皮肤以勾选标记，选择即时生效并按浏览器保存。经典是默认的黑白皮肤，不显示人物背景，随原生浅色／深色配色切换。有效的已保存选择优先；没有保存或所选皮肤不可用时使用经典。

<a id="understand-the-implementation"></a>
## 理解实现

`src/client/skins.ts` 让经典使用原生中性配色，并把 Hemi `skins.config.json` 中五套人物调色板（rail、accent、scale-600、line）映射为一小组 `--dsw-alias-*` token。客户端半部逐个注册皮肤，并在卸载时撤销注册。

背景层是挂载在 `#root` 之后的全视口 body 子元素，仅作视觉呈现。其样式表用 `-webkit-app-region: initial !important` 令其退出 app-region 采集：外壳的 darwin 规则 `body > :not(#root)` 会按 DOM 顺序从窗口拖拽面中减除 body 级覆盖层，若不退出，这个全视口 no-drag 盒子会禁用标题栏拖拽及其在 macOS 上的原生双击最大化/还原。

插件以 -10 优先级占用侧栏名称与图案、会话首页图案和运行状态图案插槽。侧栏展示 Hemi 和使用次要文字色、字号更小且文字基线对齐的 `dsh` 后缀，不展示品牌图案；折叠栏保留原生展开图标。会话首页保留主题中性文字颜色的透明波浪 H 遮罩。运行状态插槽不渲染图案，隐藏原生鲸尾，不改变状态文字与计时。皮肤配色和背景独立于黑白品牌图案，移除插件后恢复原有占用者。

<a id="further-exploration"></a>
## 进一步探索

- `packages/client/ui-theme` 拥有主题注册表、token 样式表与设置行。
- Hemi 源表位于 Hemi 仓库 `src/shared/appearance/skins.config.json`。

## 模型体验

<a id="model-experience"></a>

### 皮肤选择

#### 模型看到的内容

`overrideTokens` 颜色与插画仅在浏览器呈现，不添加模型输入。

#### Token 影响

更换皮肤不发送模型请求。

#### KV Cache 影响

更换皮肤保留模型请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 不渲染头像、待机动画与题字。

<a id="dev-note"></a>
### 开发备注

fork 新增；调色板表需与 Hemi 源保持同步。
