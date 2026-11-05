---
description: "以独立 config-only 插件层把 Hemi 模型路由装进 dsh profile：从检出打包三个 tgz、经 profile 的 plugin 命令安装，并避开已接线路由行的组合。"
kind: "package-bundle"
---

# @hemi/model-routing

[English](README.md) | 中文

## Summary

`@hemi/model-routing` 是把 Hemi 模型路由安装进 profile 的 config-only 层：`cordis.patch.yml` 插入路由行，包本身不含代码。把它与两个路由包一起打成三个 tgz，再用 `dsh plugin --profile <name> add` 一次性加入 profile。路由行为——主模型、四个角色模型与按会话的 auto/fixed 模式——归那两个路由包所有。

## Table of Contents

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装进 profile

在完成工作区构建的本仓库检出中打包安装，让两个路由包带有 `pack.mjs` 所校验的 `lib/` 产物。

```text
pnpm install && pnpm run build
node plugins/hemi-model-routing/pack.mjs <destination>
```

`pack.mjs` 把 `@deepseek-ai/dsh-hemi-routing`、`@deepseek-ai/dsh-hemi-routing-ui` 与 `@hemi/model-routing` 打进 `<destination>`（默认 `dist/`），并在其中写入 `packages.json`，记录每个包的文件名、版本与 SHA-256。

用一条 profile plugin 命令一次加入三个包——这是正常入口，参数原样转发给 profile 目录内的 pnpm：

```text
dsh plugin --profile <name> add \
  <destination>/deepseek-ai-dsh-hemi-routing-<version>.tgz \
  <destination>/deepseek-ai-dsh-hemi-routing-ui-<version>.tgz \
  <destination>/hemi-model-routing-<version>.tgz
```

准确文件名以 `<destination>/packages.json` 为准。`@hemi/model-routing` 以匹配的版本声明两个路由包为 peer dependencies；一条命令同时加入三个包即可满足。

本版本适用于版本匹配的官方 Web 组合及其 standard preset，应在用户 preset 覆盖之前应用。只在不含内置 Hemi 路由行的组合上安装本层：本检出的 web-app bundle 已接线 `hemi-routing-settings`、`hemi-routing` 与 `hemi-routing-ui`，再叠加本层会重复插入这些行。由官方上游 bundle 组成的 profile 不含这些行。

### 安装后得到什么

本层插入两个根作用域 profile 行：`hemi-routing-settings`（根作用域设置服务 `@deepseek-ai/dsh-hemi-routing/settings`，以空的 `main` 与 `roles` 初始化）与 `hemi-routing-ui`（客户端插件 `@deepseek-ai/dsh-hemi-routing-ui`）。它以 fork 的标准能力配置替换 standard preset，但不包含单独的记忆插件，并开启原生 `subagent` 的角色选择白名单。四个原生 preset（`explorer`、`oracle`、`fixer`、`designer`）提供角色 persona 与共用工具；模型路由挂载在 standard 内。等待、取消及结果通知保持原生行为。

从会话模型菜单“自动路由”旁的齿轮，或“设置 → 模型 → 配置模型路由”进入，从已配置的模型目录为主模型和四个角色——研究、评审、执行、设计（`explorer`、`oracle`、`fixer`、`designer`）——各选一个模型。角色保持“跟随主模型”时使用主模型；不能手填供应商或型号标识。

每个普通会话单独保存 auto/fixed 偏好。每个根会话默认 fixed——子代理继承委派父代理的实际模型；开启 auto 后从下一个回合起为该会话的整棵子树启用路由。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 — 点击展开</summary>

载荷包含 [cordis.patch.yml](cordis.patch.yml)、[standard.patch.yml](standard.patch.yml) 与 [roles.patch.yml](roles.patch.yml)。修改所属标准 preset 或 `packages/hemi/routing/roles.patch.yml` 后，运行 `node plugins/hemi-model-routing/sync-config.mjs --write`；打包会拒绝过期的生成配置。Hemi 输入框使用更低的插槽优先级覆盖不支持 `showComposer` 的官方客户端。[pack.mjs](pack.mjs) 把本包与 `packages/hemi/routing`、`packages/hemi/routing-ui` 一起打包；测试在 [tests/installed-smoke.mjs](tests/installed-smoke.mjs)。

回合与 step 语义概要，归路由包所有：每个回合第一条被认领的消息捕获一份模式、main 与角色路由的计划；auto 下插件在 loop 读取该步选择之前选用配置的 main 模型，委派绑定计划中的角色路由。手动选型从下一个 step 生效而非下一个回合；已准备的 step 保留其捕获的路由，已派发的委派保留其绑定路由。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [路由](../../packages/hemi/routing/README.zh.md) — 委派角色、回合与 step 语义、设置命名空间与失败行为。
- [路由界面](../../packages/hemi/routing-ui/README.zh.md) — 共用配置表单、保存行为与界面边界。

-----

<a id="model-experience"></a>
## Model Experience

间接影响：本层只插入行，每个被插入行的包拥有该行的模型侧行为。

#### KV Cache effect

本层不增加请求前缀；路由选择的改变可能改变后续请求的供应商侧缓存复用。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 在 Hemi 中，选择任一具体模型即可切换到固定模式，包括自动路由当前使用的型号。旧版 DSH 菜单通过开关切换。
- 没有跨模型回退：缺少主模型时启用 auto 以 `HEMI_ROUTING_MAIN_REQUIRED` 失败；委派时路由不可解析以 `HEMI_ROUTING_ROUTE_UNRESOLVED` 失败。
- 角色职责是提示词级别的约束：不做按角色的工具隔离；通用 `subagent` 工具仍能在其它路由上启动子代理。
- 回合计划是进程内的：宿主在回合中重启不会恢复已捕获的计划，该回合随后的委派读取实时配置。
- 模式偏好属于安装它的 profile：不随 Session 导出、不跨 profile 迁移，也不被分叉的会话继承。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`node plugins/hemi-model-routing/tests/installed-smoke.mjs <area>` 准备全新 `DSH_HOME` 与干净的官方组合，打包三个包，经真实 `dsh plugin` 入口安装，启动真实宿主，并端到端检查请求路由、会话间模式隔离与重启行为；`tests/expected/installed-routes.json` 固定期望的请求绑定。

浏览器检查默认使用 `apps/web` 固定的 Playwright 构建；先在 `apps/web` 运行一次 `pnpm exec playwright install chromium`，或设置 `HEMI_ROUTING_BROWSER_CHANNEL=chrome` 让 smoke 使用已安装的系统 Chrome。

</details>
