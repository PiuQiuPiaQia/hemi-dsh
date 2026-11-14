---
description: "开启同一 Wi-Fi 下 iPhone 对当前 Hemi 电脑端的访问，并确认配对并管理设备权限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-mobile-access-ui

[English](README.md) | 中文

## 概述

让同一 Wi-Fi 下的 iPhone 连接当前 Hemi 电脑端，并允许或拒绝其配对请求。允许访问会话、执行任务和文件之前，请核对两台设备上的六位号码。你可以撤销已配对设备，或关闭手机入口，而不停止运行中的 Agent 任务。配对内容仅可使用一次，两分钟后过期，二维码在本地生成，不发送到第三方服务。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在电脑上打开 **设置 → 手机连接**。直接开启连接，无需选择网络或输入 IP 地址。若 Wi-Fi 不可用，请让此电脑连接 Wi-Fi 后点击「重试」。使用 iPhone 上的 Hemi 扫码，或将配对内容复制到手机配对页面。核对手机与电脑上的号码，仅在号码一致且信任此手机时点击「号码一致，允许连接」。复制按钮与 JSON 统一收在「手动配对」中。

手机连接开启时，页面仅显示当前未过期的核码确认，以及可撤销的已配对设备；不显示空设备卡片或已处理请求历史。核码确认替代已使用的二维码及生成操作；过期后需明确生成新邀请。关闭手机连接会保留配对设备和运行中的 Agent 任务。操作失败时保留列表及仍有效的邀请，明确报告无法确认的结果，并提供刷新，而不声称成功。已过期或已使用的邀请不会继续显示可扫描二维码。

在已连接的 Hemi iPhone 应用中，打开 **设置 → 手机连接** 即可查看电脑名称并断开连接。断开动作仅派发一次原生清理操作并保留配对；无法确认结果时显示简短提示，不会重试。此视图不读取电脑管理资源，不显示配对二维码、网络地址或设备管理。

此可选浏览器贡献需要 mobile-access Host 服务及共享设置、语言、Remote 和资源服务。它没有配置字段，挂载时不会启动监听。没有原生能力的普通浏览器保留电脑管理行为，包括 Host 拒绝授权后的电脑端管理提示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

浏览器入口先挂载 Host 生成的 `hemiMobileAccess` 命名空间，再注册 `settings.section` 贡献。客户端 Remote 方法类型来自 `TypertClientRemote`，状态和不透明 ID 则由 Host 的仅类型入口定义。控制器暴露一个资源，仅在设置页持有它时轮询；持有者关闭时中止读取及已受理操作，移除命名空间前等待请求结束。操作仅发布 Host 的权威结果；关闭与撤销操作还会检查返回的监听或设备事实。

原生壳在主框架文档开始时注入冻结且带版本的 `window.__HEMI_MOBILE__` 能力。客户端仅将电脑名称和断开回调投射为插槽输入；原生与电脑端区域分别使用自己的钩子。原生壳负责主框架与已选择来源检查及清理，此能力不暴露令牌、secret 或 origin。

电脑端组件通过标准插槽注入获取资源钩子及窄动作集。只有明确生成邀请的结果携带令牌；该结果留在已挂载组件的本地状态中，重新挂载时丢弃。安全的 `getState` 邀请视图无法重建二维码。维护中的 `qrcode-generator` 库在浏览器内编码完整邀请 JSON，复制与手动配对路径使用同一 JSON。本地过期计时器在刷新失败时仍会移除失效邀请，不执行任何业务读取。

包内测试覆盖交互确认、双语文案、失败保留状态、权威操作结果、轮询取消、延迟操作完成及可逆注册。生产页面渲染及真实 iPhone 验证由集成组合负责；组件 fixture 不能证明这些验证已完成。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [手机 Host 类型](../mobile-access/src/types.ts) — 邀请及管理字段。
- [客户端资源](../../../docs/subsystems/client-resources.zh.md) — 持有者拥有的流。
- [客户端插槽](../../../docs/subsystems/slots.zh.md) — 注入式展示输入。

-----

<a id="model-experience"></a>
## 模型体验

### `hemiMobileAccess` 控件

#### 模型可见内容

`hemiMobileAccess` 设置控件不添加模型可见的工具、提示词或消息。

#### Token 影响

页面不发送模型请求。

#### KV Cache 影响

页面不改变模型请求前缀。

## 已知限制与待完成工作

<a id="known-limitations-and-deferred-work"></a>

此页仅管理当前电脑的 Host。

- 手机配对需要处于同一局域网，并使用兼容的 Hemi 手机客户端；不提供公网中继或独立 bot runtime。
- 离开此页会丢弃一次性邀请令牌，重新打开后请生成新邀请；配对设备保留在 Host 上。
- Host 重启会清除短期请求；持久设备记录由 Host 拥有。页面不显示已处理请求。

<a id="dev-note"></a>
### 开发备注

无。
