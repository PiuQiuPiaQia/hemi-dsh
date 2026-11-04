---
description: "预置 explorer/oracle/fixer/designer 委派角色，按用户配置的模型路由与会话级 auto/fixed 模式委派。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-routing

[English](README.md) | 中文

## 概要

`dsh-hemi-routing` 提供四个预置委派角色——`explorer`（只读侦察）、`oracle`（独立分析）、`fixer`（执行变更）、`designer`（用户界面设计）——以及一个把每个角色绑定到用户所选模型的 `hemi_delegate` 工具。会话级模式决定由谁选路：auto 模式下插件在每个回合选用配置的 main 模型并绑定每个角色；fixed 模式下不做任何路由，子代理继承父代理的实际模型。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [客户端接口](#client-interface)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

本包贡献两个 profile 行。根作用域设置服务以 `@deepseek-ai/dsh-hemi-routing/settings` 加载，条目 id 为 `hemi-routing-settings`；agent preset 插件以 `@deepseek-ai/dsh-hemi-routing` 加载在 preset 的 `plugins` 内。设置卡片通过标准 settings 管线编辑 `hemi-routing-settings` 命名空间。

命名空间包含 `main`（auto 模式的主模型路由，未配置时为 `null`）、`roles`（按 canonical 角色 id `explorer`、`oracle`、`fixer`、`designer` 各一条路由）与 `sessionModes`（按根会话 id 各保存一条 auto/fixed 偏好）。路由为 `{ provider, model, reasoningEffort? }`，`provider` 与 `model` 非空；空的 `reasoningEffort` 表示模型默认值。角色 id 与路由字段在 Loader 配置解析处校验，未知角色或畸形路由在加载时会拒绝，也会在 settings 写入持久化之前拒绝。旧的 `research`/`review`/`execution`/`design` 键在读取时一一对应到新角色。编辑任一角色时，设置表单会用新键保存完整的角色表，并保留其他角色的模型。

每个根会话默认 fixed 模式：插件不做路由，`hemi_delegate` 子代理继承委派父代理的实际模型。启用 auto 会通过 settings 管线保存该会话的偏好，并从下一个回合起为该会话的整棵子树启用路由：每个回合第一条被认领的消息捕获一份模式、main 与角色的计划，auto 下插件在 loop 读取该步选择之前选用配置的 main 模型。委派绑定计划中的角色路由；未配置路由的角色跟随 main。子代理无法通过工具参数自选路由。

主代理根据委派能否带来足够的新增证据、专业判断、并行收益或上下文隔离来决定是否派活，再根据所需产出选角色。用户明确指派时按指派执行。自动与固定模式使用相同的派活规则。

角色委派默认在当前回合等待子代理结果。同一批独立委派可以并行执行。子代理失败会返回工具错误，停止主代理也会取消当前回合正在等待的子代理。用户明确要求后台执行时，使用 `background: true`。该调用在启动后立即返回子代理 ID，完成后通过主代理的收件箱回传结果。

手动选型从下一个 step 生效，而不是下一个回合：父代理随后的请求运行在所选路由上，后续 step 的委派跟随父代理的实际路由，不再使用该回合的 auto 路由。已准备的 step 保留其捕获的路由，已派发的委派保留其绑定路由。在 Hemi 模型菜单中选择任一具体模型，宿主会先保存固定模式，再应用选择。再次点选当前型号也会退出自动路由。

模式是当前 profile 的未来执行偏好：保存在插件 settings 命名空间中，不随 Session 导出，不跨 profile 迁移，也不被分叉的会话继承。不记录任何 Hemi 会话事件，普通 Session 日志在任何 harness 构建下都保持可读。

路由模式写入按会话串行，并只在 settings 管线真正持久化后才返回。保存失败保持可见并阻塞该会话的下一个 step，直到手动切换模式完成重试；卸载插件会停止新提交，但不会在 cleanup 中等待 ConfigEditor 事务，因为事务的 Loader reconciliation 可能反过来等待同一个 cleanup。已接受的事务仍向调用方交回结果；若卸载时还有未完成的改动，日志会提示保存尚未确认。重新打开会话后，应先核对其保存的路由模式再继续。auto 模式下 main 被清空时同样失败关闭：该 step 被阻止，宿主日志说明缺少 main 模型，而不是悄悄沿用旧路由。

委派深度遵循官方 subagent 策略：可选的 `maxDepth` 插件配置与 `dsh-tool-subagent` 一致（`0` 禁止委派；省略时读取 Host 深度设置），关闭委派或深度限制会通过标准运行时拒绝调用。

<a id="understand-the-implementation"></a>
## 实现说明

根服务是 `TypertRemoteService`（`hemiRoutingSettings`），拥有配置 schema，并在启用 auto 模式时用实时 LLM 注册表校验每条路由。回合计划通过官方 `agent/inbox/claimed` 事件在该回合第一条被认领的消息上生成，先于 loop 读取该步的模型。官方 `agent/pre-step` waterfall 为根代理同步捕获 service 持有的 step 模式快照并执行失败关闭；`hemi_delegate` 用回合计划解析该 step 的路由，因此回合中的模式切换不会出现父代理已换路由而子代理仍绑定另一路由的错位。模式写入通过 `ctx.settings.mutate` 按会话逐路径寻址，并由 token 栅栏保护，旧的写结果不会覆盖更新的保存；`hemi_delegate` 通过标准 `ctx.subagents.startActivation` 以硬绑定的 `agentOptions` 启动子代理。

<a id="client-interface"></a>
## 客户端接口

客户端通过生成的 Remote 切换模式——`ctx.remote.hemiRoutingSettings.setEnabled(agent, enabled, signal?)`，返回 `RemoteResult<void>`；仅根会话可切换，缺少 main 或路由不可解析时启用分别以 `HEMI_ROUTING_MAIN_REQUIRED` 或 `HEMI_ROUTING_ROUTE_UNRESOLVED` 失败。设置卡片以 `hemi-routing-settings` 命名空间的即时 volatile 字段读写 `main`、`roles` 与 `sessionModes`，当前会话的模式直接跟随其保存的偏好，无需任何会话投影。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

角色职责是提示词级别的约束：本版本不做按角色的工具硬隔离，因为现有接缝无法给子代理打上委派角色标记；通用 `subagent` 工具（在其组合中启用 `modelSelection` 时）仍能在其它路由上启动子代理。旧版 DSH 菜单可通过模式开关退出自动路由。没有跨模型的失败恢复：委派时路由不可解析会以错误暴露，不做回退。宿主在回合中重启后的委派读取实时配置，因为回合计划是进程内的。模式保存按会话串行但不跨会话串行；不同会话的首写并发依赖 settings 管线自身的编辑锁。
