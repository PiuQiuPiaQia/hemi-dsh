---
description: "通过会话右键菜单标记未读，不改变当前选择。"
kind: "package-reference"
---
# @deepseek-ai/dsh-hemi-session-unread-ui

[English](README.md) | 中文

## 概述

在会话右键或更多菜单中选择**标记为未读**，即可留下提醒而不切换会话。下次进入时会清除提醒。标记当前打开的会话后，提醒会保留到离开并重新进入时。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

Hemi Web 组合挂载此浏览器插件。未归档会话的菜单在分叉会话之后显示此操作。没有配置字段。提醒使用已有状态点并标注**未读**；正在运行的工作和待处理交互保持原有优先级。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部 — 点击展开</summary>

[Hemi 子系统](../../../docs/subsystems/hemi.zh.md)说明插件在产品中的归属。插件通过共享的[右键菜单注册表](../../client/ui-context-menu/README.zh.md)贡献操作。[会话 UI 适配器](../../client/ui-session/README.zh.md)拥有提醒状态；插件不持有会话引用、不发送 Host 请求，也不修改会话日志。插件的 Cordis fiber 卸载时撤回贡献。

</details>

<a id="model-experience"></a>
## 模型体验

无；此插件仅改变浏览器查看状态。

#### KV Cache 影响

无；菜单操作不组装模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 提醒仅保留在当前浏览器运行期间，刷新后不保留，也不会在窗口间同步。

<a id="dev-note"></a>
### 开发备注

无。
