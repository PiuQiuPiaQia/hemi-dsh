---
description: "Hemi 独立的「模型接入」设置页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-model-access-ui

[English](README.md) | 中文

## 概述

桌面配置加载 Hemi 的「模型接入」页面，提供订阅账号、New API 导入和 API Key 接入。订阅账号在额度可用时显示周限和五小时剩余额度。每个型号提供紧凑的设置、测试和删除图标，附有本地化的无障碍名称和提示。拉取型号使用带搜索的弹窗，确认勾选后才添加。API 接入和订阅模型均可覆盖显示名称、token 限额及文本／图片输入能力。删除最后一个型号仍保留连接和凭据。

## 目录

- [使用本包](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## 使用本包

桌面配置隐藏原生「账号和余额」「模型」tab 及侧边栏账号菜单，账号操作集中在「模型接入」中。「订阅」与「API」tab 支持方向键、Home 和 End。API tab 的「接入 New API」打开弹窗。桌面端默认使用 HTTPS，可信的自建站点需要时可选择 HTTP。在弹窗内登录后，点击「登录完成，继续」。只有一个令牌分组时直接显示模型；有多个分组时先选择分组。勾选模型后点击「导入模型」，应用会创建令牌、验证模型并保存连接。关闭弹窗保留草稿，不取消原生导入；进度或结果仍显示在 API tab 中。无法读取导入状态时，弹窗会自动重试，并在恢复后清除提示。导入成功会刷新连接列表。点击「完成」关闭结果，重新打开「接入 New API」即可填写新站点。没有桌面桥接时，弹窗用于导入已有令牌。

「订阅」tab 中所有账号共用同一个 `SubscriptionCard` 组件。DeepSeek 通过 `account.connection` 复用原生登录和账号状态，以充值余额和赠金余额代替限额进度条。登录后自动读取原生 `deepseek-account` 目录，共用的模型行提供设置、测试和删除，拉取型号使用与其他订阅相同的搜索勾选弹窗。已登录订阅将拉取型号图标放在重新授权前，提供本地化提示。原生提供方将选择保存在 `selectedModels` 中，空列表也会明确保存；查询会重新读取全部可用候选，已删除型号可以再次添加。额度与余额刷新共用同一个图标按钮，提供本地化提示并在刷新期间禁用。余额刷新和退出登录使用原生账号操作，退出前确认对运行中任务的影响。

<a id="use-this-package"></a>

Key 预设只提供连接地址，不预填模型 ID。保存连接前，需要从接口读取或手动输入型号。拉取弹窗每次打开都重新读取服务端，并提供「刷新」操作。搜索位于可滚动的模型列表上方，底栏显示全部已选数量，包括被筛选隐藏的型号；「全选」只操作匹配的型号。刷新失败时清空候选列表并显示错误与重试入口，不删除已保存的型号。New API 导入后的连接使用同一设置编辑器。订阅与 API Key 卡片渲染同一个共用的 `ProviderCardContent`，API Key 的拉取型号入口位于卡片头部。

模型设置可编辑显示名称、上下文长度、最大输出 token 及文本／图片输入类型。编辑器直接展示生效值，包括继承的图片能力，始终显示文本／图片选项。保存未改动的值会保留继承；清空可选文字或 token 字段会移除对应覆盖值。新连接的模型草稿随连接保存；已有型号的设置单独确认保存。取消对应弹窗不修改设置。

## 模型体验

<a id="model-experience"></a>

### 连接编辑

#### 模型看到的内容

The editor submits account operations to the `model-access` Host plugin, which owns import validation requests.

#### Token 影响

单纯编辑不发送模型请求；显式验证导入可能消耗提供方 token。

#### KV Cache 影响

编辑器不添加对话前缀；选择导入模型可能改变提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 浏览器登录需要桌面壳。没有桌面桥接时，可以使用已有令牌导入表单。

### 开发备注

<a id="dev-note"></a>

无。
