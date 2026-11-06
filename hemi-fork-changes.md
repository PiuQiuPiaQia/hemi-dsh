# Hemi fork 改动账本（hemi-fork-changes）

本账本记录上游原有文件的修改、原因与合并核对项；实施要求以 [Hemi 二开约束](docs/defensive-patterns/hemi-fork.zh.md)为准。Hemi 自有文件登记在建包记录中，与上游原有文件的修改分开。

**⚠️ 关键规则（踩坑实证）：凡通过 preset 行 / patch 行引用的插件（含 host 工具包），其包名必须出现在 `packages/bundle/web-app/package.json` 的 dependencies（resolver manifest）里，否则行解析失败、会话创建报 `agent-preset/invalid: <id>: never started`（构建门禁不拦此错，只在运行期暴露）。**

<a id="hemi-customization-isolation"></a>
## Hemi 定制归属与上游合并

当前归属与合并核对以本节为准；下方日期条目保留实施记录。

功能与组件优先放入 `packages/hemi/` 的所属插件。非插件的 Electron 适配集中在 `packages/hemi/customizations/`，桌面壳通过包入口导入；皮肤继续由 `packages/client/ui-hemi-skins/` 插件提供，独立安装层保留在 `plugins/`。详见[目录规则](packages/hemi/README.md)。

GitHub 桌面分发由 `packages/hemi/customizations/release/` 拥有，参考原 Hemi 的公开 generic 清单与单一 publisher，保留 DSH 原生渠道、任务停止确认和安装。Releases 存放固定版本附件，独立分支按目标和渠道保存清单，因此单平台发布无需跨架构合并或中继。`apps/desktop/scripts/desktop-auto-update-environment.mjs` 在统一解析入口调用 Hemi 适配并拒绝误用 COS；`desktop-package-environment.mjs` 只增加文件管理的 Hemi 配置，过滤父进程重定向；`desktop-policy-environment.mjs` 及声明文件允许显式关闭独立策略服务。没有现成的分发 provider 注册入口，因此保留这些窄打包接入，客户端主进程与更新状态机不修改。`scripts/check-workspace-constraints.ts` 仅为该私有适配包登记预编译阶段使用的 `.mjs` 发布工具、声明文件与公开证书，不放宽其他包的文件规则。新的薄 CLI `hemi-github-release.ts` 和 `apps/desktop/package.json` 接入自有发布器，`.github/workflows/hemi-desktop-release.yml` 默认使用 GitHub 托管 runner 和社区签名，可选正式证书机器，独立于上游 COS 工作流。验证涵盖原生清单解析、完成记录与哈希、失败恢复及工作流顺序；真实签名发版、公网下载和已安装升级仍由发布操作者验收。合并上游时核对分发解析、dotenv 隔离、显式策略关闭、完整打包记录、非强制分支写入，以及上游是否已有可替代的配置入口。

GitHub 社区签名由自有 `release/signing.mjs`、`setup.mjs`、`cua.mjs` 管理，复用原 Hemi 固定证书的公开部分，私钥仅由现有 P12 secrets 提供。macOS 使用固定叶证书要求、无时间戳、不公证；Windows 明确未签名。桌面 `electron-builder-config.mjs`、声明文件、`macos-signing-keychain.mjs`、`package-target.ts`、`prepare-dsh.ts` 和环境加载器仅按文件中显式模式接入，不改变 DSH 默认正式签名和 COS 流程。`macos-runtime.ts` 提供通用签名策略入口，复用现有遍历、JIT 权限、Python 别名校验和并发收敛，Hemi 自有策略签署固定证书、继承 JIT 权限并为无 Team ID 的运行时补充库校验例外，验证封存 helper；正式证书与缓存策略保留。原生 CUA `build_app.py` 增加可选时间戳及 requirements 参数，在写入内容摘要清单前签名，默认行为不变；社区 helper 不伪造官方 npm 公证清单。私有配置与临时钥匙串只清理自有路径，不修改证书信任，也不生成或轮换 Hemi 密钥。隔离证书的真实 Electron 验证已通过 Squirrel.Mac 接受变更应用；正式安装、系统权限延续和公网升级仍需实际发版验收。合并上游时核对自定义 signer 调用、证书固定要求、凭据生命周期、helper 清单、完成记录模式和签名验证开关。

模型菜单的组件、样式、替代选型状态和注册现由 `routing-ui/src/client/model-picker/` 拥有。原生 `ui-model-selection` 恢复自己的组件和目录服务，保留 `/model`；通用 `showComposer` 配置默认开启，Hemi 组合显式关闭并由路由 UI 插件注册菜单。菜单共用原生目录，不复制目录控制器。定制菜单样式和排序随所属组件维护。推理强度在模型按钮右侧独立展示，沿用原生能力判断和选型保存，自动路由在同一位置展示按会话保存的四档选择器；此布局只修改 Hemi 自有组件。

推理能力缺失时，由 `hemi/model-access/src/protocol-reasoning.ts` 提供协议默认档位；`llm/llm-pi-ai` 提供通用的临时配置瀑布和型号默认档位解析，目录、设置校验和请求共用同一结果，无 Hemi 插件时保持上游行为。自动路由的四档、会话保存与型号映射归 `hemi/routing`，界面归 `hemi/routing-ui`；现有同步选型钩子无法等待型号能力，因此映射放在已有等待式 pre-step，保留原生子任务绑定和生命周期。合并上游须核对未知能力、显式禁用、默认值与实际字段发送，以及四档选择不退出自动路由。

模型导入的完整 ID 匹配与默认能力展示归 `hemi/model-access/src/model-catalog.ts` 和 `hemi/model-access-ui`。现有 profile 瀑布无法独立表达“继承输出容量但不设置请求上限”，因此 `llm-pi-ai/src/catalog.ts`、`config.ts` 保留通用 `catalogProvider` 引用及校验，只继承名称、输入类型和容量；`index.ts` 导出目录读取及默认值，确保 Hemi 使用已发布入口而非源码路径。合并上游须核对引用失效报错、显式覆盖优先、原连接传输保持独立及未修改默认值的保存行为。实际验证包括 117 项定向测试、型号设置浏览器回放、构建包入口导入冒烟、`build:artifacts`、`build:check`、`doc-sync` 与定向 lint。

独立推理选择器的浏览器场景为 `apps/web/tests/hemi-effort-picker.e2e.ts`；`apps/web/tsconfig.json` 排除该 Host 场景，`tsconfig.host.json` 负责检查，产品运行时无需新增扩展点。实际验证包括 29 项菜单行为测试、Chromium/WebKit 浅深色与 390px/1280px 布局、保存和焦点恢复、`build:artifacts`、`build:check` 与 `doc-sync`；合并上游时须保留两组按钮和对应测试的能力判断。


独立安装层使用插槽优先级覆盖旧官方模型菜单，并复用其已声明的标签和选项子插槽；支持 `showComposer` 的 Hemi 组合则关闭原生菜单。四个角色 preset 的来源为 `packages/hemi/routing/roles.patch.yml`；`plugins/hemi-model-routing/sync-config.mjs` 生成内置角色配置和独立安装配置，打包与路由组合测试拒绝配置漂移。独立层覆写匹配版本的 standard preset，保留原生异步行为。

| 上游文件或模块 | 保留修改的背景 | 合并上游时核对 |
| --- | --- | --- |
| `client/ui-settings-account` | 设置从账号菜单移出，改为账号行末尾的独立齿轮按钮（含折叠栏纵向堆叠与本地化提示），菜单保留意见反馈与登录/退出 | 上游恢复菜单项时齿轮按钮与测试/快照同步取舍 |
| `client/ui-model-selection` | 通用 `showComposer` 开关、模型标签与工具选项类型；无需导入 Hemi 组件或保存 Hemi 模式 | 默认原生菜单、关闭后 `/model` 与目录仍可用、Hemi 菜单接管与卸载 |
| `client/ui-chat` | 回合用量增加可替换插槽；原生面板保留为 fallback | 插槽声明与渲染一致，无插件时使用原生面板 |
| `client/ui-settings-models`、`ui-settings-general` | 复用原生供应商编辑器并替换导航，避免重复入口 | 编辑器工厂、默认入口开关、导航与页面选择相同优先级 |
| `core/agent`、`api/session-controller` | 用户手动选型前等待路由插件保存固定模式 | 同型号选择也发出事件；保存失败不得先切换模型 |
| `subagent/subagent` | 原生角色绑定模型和推理强度的通用钩子 | 绑定后能力校验；原生工具、独立生命周期和完成通知保持上游行为 |
| `scripts/gen-cordis-catalog`、`gen-doc-graphs`、`doc-standard.spec` | 登记 Hemi 服务、DTO 文档归属和 Electron 适配库分类，接口目录由生成器维护 | 新增或移除插件时更新归属映射，运行目录生成和文档检查 |
| `scripts/session-snapshot-corpus.corpus` | 发现快照测试时跳过桌面开发应用产物，避免扫描其依赖副本 | 仅跳过 `.desktop-build` 产物，不排除源测试 |
| `core/session` | 非 surface 的辅助摘要事件允许携带可忽略标记 | 写入保留标记，缺少插件的读取方可跳过辅助记录 |
| `llm/llm-pi-ai` | 插件复用认证工具；移除型号时保留授权和连接 | 导出、空目录和型号过滤行为 |
| `llm/token-meter` | 更换模型后清除旧上下文压力样本，避免错误占用率 | 投影版本与恢复、路由变化后重新采样 |
| `apps/desktop` 的 `main`、`preload-app`、`ipc` | Electron 资源不属于 Host 插件；只导入二开适配，壳保留授权与关闭次序 | 沙箱 preload 不含主进程代码、IPC 发送方检查、关闭时先保存导入状态 |
| `apps/desktop-host`、桌面 `host-process` 与 boot handler | HMR 后从当前 Host 取得实时启动清单，避免旧资源地址失效 | IPC 请求关联、Host 更换检查、连续构建重载 |
| 桌面 `scripts/dev`、`development-app` | 开发壳加载本次构建并固定 runtime；隔离同步目录元数据，拒绝复用失效签名 | 开发入口刷新与打包入口不混用 |
| `scripts/check-workspace-constraints` | Hemi 包使用 fork 源码地址；Electron 适配保持私有，单独声明构建入口的发布文件 | 不改变其他 DSH 包的仓库和发布规则 |
| bundle、preset、依赖清单、tsconfig | 装配插件、角色和构建依赖；客户端源码别名确保真实组合测试不依赖已构建包 | 插件行可解析，独立安装层与内置组合不重复注册 |
| `client/ui-primitives`（Toast.module.css）、`client/ui-attachment`（DropOverlay.module.css） | 两个纯视觉覆盖层（顶部公告条、全屏拖入遮罩）门户到 body 后被壳的 darwin `body > :not(#root)` no-drag 规则收集，在展示期间抹掉标题栏拖拽与原生双击最大化；各加 `-webkit-app-region: initial !important` 退出收集（同 ui-hemi-skins Backdrop 先例），pointer-events 与按钮可点性不变 | 壳规则或覆盖层退出先例改变时同步三处声明与对应 CSS 断言测试；确认 toast 动作按钮与拖入事件仍可达 |

`core/session/src/known-event-types.ts`、持久化与配置目录、客户端插槽目录由生成器维护；出现 Hemi 名称是源声明的生成结果，不手写删改。相关测试与预期输出跟随所属行为维护。未涉及本次收拢的其他工作区改动保持原状。

## 2026-11-05 · 覆盖层退出拖拽收集（Toast / DropOverlay）

- `packages/client/ui-primitives/src/Toast.module.css` 的 `.toast` 与 `packages/client/ui-attachment/src/DropOverlay.module.css` 的 `.mask` 增加 `-webkit-app-region: initial !important`（带 Hemi fork 注释）。两处均为门户到 body 的纯视觉覆盖层：顶部 toast 覆盖标题栏拖拽带、拖入遮罩覆盖整个窗口，被壳的 darwin `body > :not(#root)` no-drag 规则收集后会抹掉拖拽矩形与原生双击最大化（Hemi Backdrop.module.css 已确立同一退出方式）。
- 命中测试不变：toast 仍 `pointer-events: none`、动作按钮 `pointer-events: auto` 且保留壳的交互 no-drag 规则；遮罩仍透传拖入事件。
- 验证：`pnpm exec vitest run packages/client/ui-primitives/tests/toast.client.spec.tsx packages/client/ui-attachment/tests/drop-overlay.client.spec.tsx` 全部通过（新增各 2 项 CSS 断言：退出声明存在、click-through/可点性保持）。这些是 CSS/几何断言，非 Electron 原生拖拽行为验证；原生双击行为需在运行中的桌面窗口人工确认。

## 2026-11-05 · 备份独立设置页

- `packages/hemi/backup-ui` 改用原生 `settings.section` 插槽，注册独立的「备份 / Backup」导航入口，位于记忆页之后；移除原先的 `settings.general.item` 卡片注册。沿用原有备份组件、Remote、配置与恢复流程，页面使用本地化区域名称。
- 本次没有修改上游设置框架、插槽定义、核心或桌面壳；既有插件装配不变。中英文 README、升级指南与独立安装层的说明同步使用独立备份页入口。
- 注册测试覆盖中英文标签、通用页不再重复注册，以及先撤下设置页再卸载 Remote。`pnpm exec vitest run packages/hemi/backup-ui/tests` 两项通过；`build:artifacts` 八项和随后 `build:check` 两项通过，限定 UI 源码与测试的 lint 通过，相关文档配对及升级指南检查通过。
- 当前运行的桌面开发窗口经页面刷新后，已实际点击「设置 → 备份」，独立页可见且无页面异常；不重启 Host、不执行会话输入、不更新安装版应用。截图保存在本机临时目录，未提交用户界面内容。
- 独立安装冒烟 `node plugins/hemi-backup/tests/installed-smoke.mjs .artifacts/hemi-backup-tab-complete` 11 项通过，覆盖导航点击、备份恢复及重启后的目标加载；启动弹窗和异步状态加载均通过可观察状态等待。
- 上游合并核对：继续使用 `settings.section` 提供导航和页面挂载，保留本地化标签及卸载顺序，独立安装与产品内置组合都只注册一个备份页。

## 2026-11-05 · 备份与恢复的数据保护

- 归属：`packages/hemi/backup` 持有采集、流式打包、归档校验与恢复策略；`packages/hemi/backup-ui` 持有恢复说明与本地化文案。`plugins/hemi-backup` 继续作为独立安装层，测试使用隔离 profile，不写入用户数据。
- 已有 Session 目录保持原样，不移动、覆盖或删除本地代际，也不向已有目录增加备份代际；不同或额外的备份文件保存到 `restore-safety/restore-*/dsh/sessions/`。缺失的 Session 目录通过同卷临时文件和排他链接发布，遇到并发创建保留现有文件。该策略不接管原生调度、队列、取消或写锁。其他数据保留逐文件合并策略，跨卷移动先完成复制；失败报告保留部分恢复的不确定性和安全副本位置。
- manifest 通过 Zod 校验；分卷名在读取或下载前校验。解压器校验普通路径与 GNU 长名、tar 校验和及结束标记，拒绝目录穿越、绝对路径、Windows 别名、链接、重复文件和白名单外的数据。直接恢复调用也校验路径。
- 打包统一由 Node pipeline 传播源读取、压缩与输出错误，关闭分卷后清理未完成集合；失败不会继续上传或执行保留清理。采集新增实际记忆目录 `hemi-memory/`，保留旧 `memory/` 的读取范围。
- 上游文件：本次修复未新增或修改 DSH 核心、API、桌面壳及原生持久化实现；`pnpm-lock.yaml` 由 pnpm 更新备份包的 Zod 依赖。现有装配仍位于 `packages/bundle/web-app/cordis.patch.yml`、其 `package.json`、聚合 tsconfig 和路径映射；这些是既有插件解析与构建登记，不需要新增扩展点。独立安装层与内置组合不得叠加注册。
- 升级行为见[备份恢复指南](docs/upgrade-guide/v0.2.2-alpha.3/hemi-backup-restore/guide.zh.md)。旧归档保持可读，但无法补回当时未采集的 Hemi 记忆；迁移前需重新备份。未修改 Session 格式、持久化类型、Remote 方法或字段。
- 合并上游时核对：现有设置插槽与 Remote 挂载/卸载可用，备份行能被 resolver 解析，Session 目录布局与原生排他发布行为仍相容；保留本地代际与并发写入句柄的回归测试，重跑独立安装、恢复与重启校验。若上游提供等价备份入口，评估移除既有装配登记，避免重复安装。
- 实际验证：Node 24.14.1 下 `pnpm exec vitest run packages/hemi/backup/tests packages/hemi/backup-ui/tests` 45 项通过，包含打开的写入句柄、备份额外代际、并发排他发布、越界路径、分卷名、读取/磁盘写入失败、跨卷移动与三类记忆恢复；恢复说明的中英文预期文本保存在 UI 包的 `tests/expected/`。归档流程不产生模型输入或新的 Session 事件。
- 构建与安装：`pnpm exec tsc -b packages/hemi/backup packages/hemi/backup-ui`、两个包的 `bundle`、`pnpm run build:check`（Host/Client 两项）与限定备份源码和测试的 `scripts/run-oxlint.ts` 均通过；`node plugins/hemi-backup/tests/installed-smoke.mjs .artifacts/hemi-backup-safety-isolated` 11 项通过，使用独立 `DSH_HOME` 和 `DSH_AGENTS_HOME`，覆盖 tarball 安装、设置页、备份、三类记忆恢复及重启。升级指南检查、三个相关文档配对检查及 diff 空白检查通过。
- 全仓剩余阻塞：最新 `build:artifacts` 和 `verify-package-dependencies` 在未涉及本修复的 `hemi/model-access/src/index.ts:82` 遇到 TS2322（只读 `input` 数组不能赋给可变 `ModelOptions`）；没有为此修改接入功能。`doc-sync` 为 40 通过、3 失败：现有 Hemi 服务角色分类缺失、文档配对记录不同步、站点缺少 `reference/subsystems/workflow.html`。本次三个文档配对已单独通过。未运行真实 WebDAV 或 Windows 验证，也未更新用户安装的应用。


## 2026-11-05 · 恢复原生子智能体委派行为

- `packages/subagent/tool-subagent` 的源码和说明恢复 DSH 基线，移除额外的等待配置、后台参数、前台取消联动和直接答案回执。standard 与四个角色 preset 使用原生异步委派。
- `packages/subagent/subagent` 只保留角色模型选项钩子及绑定后的能力校验。Hemi 插件仍按角色绑定供应商、型号和推理强度，不改变已发布子任务的生命周期或完成通知。
- 历史同步工具回执仍由 Hemi 用量组件读取，不改写已有会话。新委派按原生会话目录参与全会话用量汇总。

## 2026-11-05 · 设置独立入口（ui-settings-account）

- 上游 `packages/client/ui-settings-account`：账号下拉菜单移除 Settings 项，账号行末尾新增独立齿轮按钮直接打开设置（Tooltip 本地化标签 + `settingsShortcut` 键帽/`aria-keyshortcuts`）；折叠侧栏内 36px 账号与设置按钮纵向堆叠。菜单保留意见反馈与登录/退出。同步更新测试、菜单快照与 README（中英）。

## 2026-11-05 · 自动记忆生命周期

- `packages/hemi/memory/src/lifecycle.ts` 为主会话添加每步记忆上下文、压缩交接和等待完成的退出摘要。退出摘要记录请求、结果、失败阶段和提供方用量。
- `packages/core/session/src/index.ts` 的非 surface 日志写入支持可选 `ignorable: true`。Hemi 摘要事件使用此标记，旧读取方可保留并跳过。同步更新 Session API 文档和生成的事件目录。
- 构建时发现源目录中的误生成文件。通过相邻 TypeScript 源文件和 source map 确认后，将 64 个产物保存在 `.artifacts/memory-lifecycle/emitted-src-backup/`，以便需要时恢复。

## 2026-11-05 · 记忆设置页

- `packages/hemi/memory-ui/` 通过 `settings.section` 注册独立「记忆」页。`packages/hemi/memory/settings` 在 Host 根作用域提供读写接口，与 preset 内的记忆工具共用文件。保存时在写锁内核对版本。
- `packages/bundle/web-app/cordis.patch.yml` 注册 Host 和客户端插件，`packages/bundle/web-app/package.json` 增加客户端包的解析依赖。
- `tsconfig.client.json` 引用客户端包。`apps/web/tsconfig.json` 和 `tsconfig.host.json` 将真实设置页测试归入 Host 检查，`pnpm-lock.yaml` 记录工作区依赖。

## 2026-11-04 · 角色路由插件（hemi-routing）

新增自有包：
- `packages/hemi/routing/`：host 提示词插件。Config = `roles: {角色名 → {provider, model, reasoningEffort?}}`；apply 把角色→路由表渲染成系统提示词段（锚定 TOOL_SUBAGENT 段序），指导主代理在 subagent 委派时按角色显式传 provider/model，未列角色继承父路由，路由被会话策略拒绝时回退。路由权威仍在 Plugins 页"子代理"设置（allowedModels 会话策略），本插件只做角色语义层。

改动的上游文件（2 处）：
1. `tsconfig.host.json`：references 增加 `{ "path": "./packages/hemi/routing" }`。
2. `packages/bundle/web-app/presets/standard.patch.yml`：persona 行后新增 `hemi-routing` 行（示例角色表指向当前默认路由，用户按需改）。
3. `packages/bundle/web-app/package.json`：dependencies 增加 `@deepseek-ai/dsh-hemi-routing: workspace:*`（resolver manifest——必需，见顶部规则）。

同时补记：hemi-memory 的 resolver manifest 行（`@deepseek-ai/dsh-hemi-memory: workspace:*`）——之前的记忆插件提交漏了它，导致该插件的 preset 行一直 "never started"（本次发现并修复）。

验证：单元渲染（role 表→提示词段文本、空表不出段）+ 全量构建 10 gates + dev 新会话零报错。

## 2026-11-04 · 跨会话记忆插件（hemi-memory）

新增自有包：
- `packages/hemi/memory/`：host 工具插件。存储=markdown 文件（`$DSH_HOME/hemi-memory/` 下 `MEMORY.md` 长期 / `daily/YYYY-MM-DD.md` 日志 / `SCRATCHPAD.md` 便签，用户可直接编辑）；工具=`memory_write`（append/overwrite，daily 只追加）、`memory_read`、`memory_search`（全库大小写不敏感逐行检索，40 行上限）、`memory_forget`（按子串删行并收拢空行）。路径用 `@deepseek-ai/dsh-home-paths` 直连库依赖。

改动的上游文件（2 处，均为单行登记）：
1. `tsconfig.host.json`：references 增加 `{ "path": "./packages/hemi/memory" }`。
2. `packages/bundle/web-app/presets/standard.patch.yml`：agent preset plugins 列表在 tool-schedule 后新增 `hemi-memory` 行（带 fork 注释）。

验证：包级单元脚本全生命周期通过（临时 DSH_HOME 下注册 4 工具、三存储写入、搜索命中、读取、删行、非法目标拒绝，磁盘布局正确）；dev 新会话创建无报错（preset 组合通过，组合失败会响亮报错）。语义检索/每日自动摘要延期。

语音（hemi-voice）：按用户决定砍掉不做，需求原文留档。

## 2026-11-04 · 外部插件抽离试点（结论：部分可行，dev 运行时有墙）

试点内容：把 hemi-skins 从 bundle 锚点模式抽离为"独立构建 → tarball → profile 安装"。

已验证可行：
1. **独立构建**：`pnpm --filter @deepseek-ai/dsh-client-ui-hemi-skins run bundle` 产出正确闭包格式 client.js（1.45MB 含背景图资产），不依赖聚合构建；
2. **打包**：`npm pack` 出 tarball（workspace: 协议会被 pnpm 重写为实际版本）；
3. **profile 安装**：tarball 可装入 profile node_modules + 激活行写进 profile 用户补丁层（`$DSH_HOME/profiles/desktop/cordis.patch.yml`，用户数据非源码）；
4. **仓库锚点可完全拆除**：拆除后 `pnpm run build` 聚合构建全绿（上游纯净）。

阻塞点（未解决）：
5. **dev 运行时不加载 profile 安装的 client 插件**：boot roster 无入口、无响亮报错。dev 的 client 批次来自 bundle/dev 项目集；profile 外部插件是**打包版**的能力（自带 `resources/runtime/cli/bin/dsh` 才能对 desktop profile 执行 plugin add——源码 CLI 在 `apps/cli/src/args.ts:83 rejectElectronProfile` 无条件拒绝 profile 名 "desktop"）；
6. npm 上 `@deepseek-ai/dsh-client-*` 最新仅 0.0.1-rc.1，远落后 fork 的 0.2.2-alpha.3——仓库外构建拿不到新版类型，外部独立构建路线不现实。

当前决策：**恢复 3 个锚点**（bundle 内置，产品组成），皮肤包保持"标准插件格式、随产品 bundle 分发"。外部插件路径留待：产出打包版后验证 `plugin add` 全流程，或上游开放外部构建工具链后再评估。语音（hemi-voice）按用户决定砍掉不做。

其他发现：dev 桌面多实例会抢 9222/9229 端口（后启动的绑定失败但应用照常跑），重启前务必先停旧实例，否则探针会打到旧窗口得出错误结论（本轮踩过）。

## 2026-11-04 · 皮肤主题（P0-2 第一步）

新增自有包：
- `packages/client/ui-hemi-skins/`：Hemi 六套皮肤 → DSH 别名 token 主题 + `overrideTokens` 持久覆盖层（token-only v1，默认应用 `cafe-blue` 晴海蓝），已实测 body 内联 token 生效。

改动的上游文件（3 处，均为单行登记）：
1. `tsconfig.client.json`：references 增加 `{ "path": "./packages/client/ui-hemi-skins" }`。
2. `packages/bundle/web-app/cordis.patch.yml`：`ui-brand-official` 行后新增 `ui-hemi-skins` 行（带 fork 注释）。
3. `packages/bundle/web-app/package.json`：dependencies 增加 `@deepseek-ai/dsh-client-ui-hemi-skins: workspace:*`。

机制结论（重要）：
- **第三方主题激活必须用 `ctx.theme.overrideTokens(source, {token:{light,dark}})` 覆盖层**；`setTheme('<第三方id>')` 只改内存偏好，宿主设置 schema 只认 light/dark/system，下一次 adopt 会打回内置值（实测复现）。
- 双半包（如 ui-theme）的 tsconfig 引用要指到 `../ui-theme/tsconfig.client.json`，指到包根会报 composite 错。
- 首次构建后启动，插件行进了 boot roster/批次但模块未执行；重建+重启后正常执行（怀疑批次 rev 缓存/HMR 旧态），如再遇到先重启一次再排查。

已知取舍：v2 已含背景图+题字（backdrop.ts 固定层 z-index:-1，webp 走 lib/assets 内容哈希产物；经典皮肤无素材自动隐藏）。上游文件改动仍只有 3 处。待办：待机动画 webm、头像、icons 替换；包内有一处未引用的旧 backdrop.css（rm 被确认门拦，待手动清理）。

## Hemi 模型与路由设置页

- `packages/hemi/model-settings-ui` 通过 `settings.section` 的 `models` 优先级接管页面，保留同一导航入口。桌面 profile 加载；其他 profile 可以通过补丁启用。
- `packages/hemi/model-settings` 通过现有 LLM runtime 测试已保存的型号，使用独立的测试提示，不执行工具或写入会话。
- DSH 的供应商编辑器提取为 `settings.models.editor` 工厂，保持原有凭据、模型编辑、添加和扩展插槽。设置导航使用插槽当前生效条目，避免接管时出现两个模型菜单。

## Hemi 模型接入设置页

- `packages/hemi/model-access-ui` 注册独立的「模型接入」入口，由桌面 profile 启用。
- `packages/hemi/model-access` 复用 DSH OAuth 和凭据存储，接入 ChatGPT Codex 与 GLM Coding Plan 的额度查询，并迁移 GLM 的项目令牌续签和签名推理。DSH Pi 适配器入口只额外导出已有的配置和凭据工具。
- `packages/hemi/customizations/src/desktop-new-api.ts` 将旧 Hemi 的 New API 浏览器导入流程接到独立登录窗。用户确认计划后创建并验证令牌，Host 一次保存同批路由，导入中断后可核对创建结果并恢复。已有令牌导入仍可使用。

- 「模型接入」使用独立设置 ID，提供 Hemi 订阅、New API 和 API Key 三种接入方式。DSH 原模型编辑器及「模型」设置入口保留，桌面 profile 沿用原生导航默认值，自定义页面提供路由与连接测试。

- 原生入口验证：移除 `packages/bundle/web-app/cordis.patch.yml` 的桌面隐藏配置，并在当前开发 profile 显式启用 `showSettingsSection` 以热更新。真实 Electron 已打开「模型」页，确认供应商编辑和添加入口可见、「模型接入」仍保留。构建产物通过；聚合类型检查受已有皮肤测试类型错误阻塞，`doc-sync` 受已有 JSDoc、链接、翻译配对等错误阻塞。合并上游时保持原生入口默认可见。

- 模型接入提供逐型号删除与拉取添加，订阅额度紧邻账号名称。Pi 适配器增加可选 hiddenModels，供清空型号时保留连接与凭据，默认沿用原目录。

## 2026-11-05 · 原生角色子智能体

- `packages/hemi/routing` 移除自定义 `hemi_delegate`；根设置服务通过通用 `subagent/resolve-agent-options` 扩展点，按所选角色绑定用户配置的模型和推理强度。保留自动/固定模式、回合快照与手动选型的行为。
- `packages/bundle/web-app/presets/hemi-roles.patch.yml` 注册 explorer、oracle、fixer、designer 四个原生预设，分别组合 persona 与工具。standard 的原生 `subagent` 暴露角色枚举，启动后立即返回子代理 ID，结果沿原生收件箱通知交付。
- 上游仅保留通用模型选项扩展点；`tool-subagent` 恢复上游源码与工具协议，不增加等待、取消或交付分支。角色子会话、团队任务、消息、恢复和树状管理使用原生服务。
- 原来的历史工具记录保留可读，不改写用户会话。

## 2026-11-05 · 会话全部模型用量

- 在 `packages/hemi/routing/src/usage.ts` 注册自有 `hemiModelUsage` 投影，按供应商/模型累计实际调用，保留输入、输出、缓存读写、推理和上游总量；含重试与有记录的压缩/记忆摘要，不重复计算 fork 继承历史。
- `packages/hemi/routing-ui/src/client/usage/SessionUsage.tsx` 替换底部用量组件，递归汇总原生子会话目录，展示各模型数据及缺失状态。面板打开时自动刷新，支持历史记录与窄屏，无需改动 DSH 用量组件。

## 2026-11-05 · 桌面热更新后的启动清单

- 桌面启动 IPC 改为每次向当前宿主请求实时 index injections，避免重放首次启动时的插件版本地址。原来的旧资源被宿主淘汰后，页面重新加载仍可取得当前资源。
- 通过现有私有控制 IPC 读取，不新增 HTTP 接口；返回前核对宿主身份与地址，拒绝混用更换前后的宿主数据。
- 桌面启动/进程通信 200 项回归、浏览器三轮旧资源失效后重载、真实 Electron 三轮更新重载验收通过。涉及主进程，开发应用需完整退出后重新启动一次。

## 2026-11-05 · 模型拉取弹窗与能力编辑

- `packages/hemi/model-access-ui` 复用标准 Modal，统一 API 与订阅的拉取弹窗，提供搜索、当前筛选结果全选和确认添加。模型设置编辑显示名称、上下文长度、最大输出 token 和文本／图片输入；新建连接的改动随连接确认保存，已接入型号使用独立设置弹窗。
- `packages/hemi/model-access` 按设置版本保存编辑字段，保留协议、推理、兼容选项和其他型号顺序。普通连接沿用 `llm-pi-ai` 模型字段，自有 GLM 适配器通过 `subscriptionModelOptions.bigmodel` 应用覆盖值；清空可选值恢复继承。输入类型继承沿用 DSH 的空数组表示，不把已有连接误判为非法输入。
- 上游手写改动仅为 `scripts/gen-cordis-catalog.ts` 登记两个 Hemi DTO 的文档所有者；现有原生编辑器工厂不提供独立逐模型表单，因此弹窗和编辑逻辑留在 Hemi 插件内，未修改 DSH 编辑器或适配器。配置及 Cordis 文档由声明重新生成。合并上游时核对模型字段和继承规则，若提供可复用逐模型工厂则评估替换本地表单。
- 验证：构建产物、聚合类型检查、9 项模型字段验证、API 与 GLM 真实 Loader/浏览器组合回归通过；新增两份 UI 预期输出，390px 浅色／深色弹窗已检查，当前 Electron 开发窗口已重启并验证新接口读取，停留在「模型接入」。导出 JSDoc 和本次目录／配对检查通过；全仓 UI 文案检查仍有其他页面的 5 处已有硬编码。`test:gui` 为 728 文件通过、12 文件失败，失败涉及既有客户端测试运行时缺少 Hemi routing 解析及皮肤／用量样式规则，未修改这些功能。

## 2026-11-05 · 订阅型号实时拉取

- `packages/hemi/model-access` 每次查询都请求服务端，移除订阅候选型号的内置目录来源。Codex 查询账号 `/backend-api/codex/models`；Claude 支持鉴权型号分页；Copilot 查询当前代理端点并采用线上可选策略；GLM 读取 ZCode 在线个人／团队 Coding Plan 发布目录。查询失败明确报错，不回退旧候选；公开目录不携带账号凭据，下载仅接受官方 CDN 且不跟随重定向。请求预算和外部客户端版本由 `subscriptionDiscovery` 配置。
- GLM 新型号沿用原有签名传输，并通过已有 Pi 适配器解析默认参数；已有型号的推理能力和用户覆盖值保持原样。移除已有型号不依赖外部目录可用性。拉取弹窗增加「刷新」，重新请求后清除旧候选和未确认选择，不修改已保存的型号。
- 手写行为改动均留在 Hemi 插件与自有浏览器用例；配置、Cordis 和客户端目录从声明重新生成。合并上游时核对官方型号接口、外部版本及 GLM 发布目录结构，不以本地静态列表掩盖不兼容。
- 验证：构建产物、16 项字段／订阅单元测试、两项真实 Loader／浏览器回归与预期输出重放、43 项文档检查通过；已用公开服务验证 GLM 控制面和 CDN 来源。聚合检查 Host 通过，Client 受已有 `ui-settings-models/tests/apply.client.spec.ts` 类型断言错误阻塞。任务结束后已重启当前开发版，真实 Codex 账号查询成功并显示 5 个未接入候选，GLM 在线目录查询成功且无新增候选；未修改账号型号选择，未执行真实模型推理。

## 2026-11-05 · DeepSeek 账号接入订阅页

- `packages/hemi/model-access-ui` 在「订阅」tab 中由同一个 `SubscriptionCard.tsx` 渲染所有订阅；DeepSeek 用充值余额和赠金余额代替额度进度条。额度与余额共用 `UsageRefreshButton` 图标、Tooltip 和刷新期间的禁用状态。登录后自动读取型号，共用型号设置、测试、删除及搜索勾选添加弹窗；删除全部型号仍保留登录、余额和型号覆盖值。
- 上游 `ui-settings-account` 增加通用 `account.connection` factory，遵循原生账号权限和插件生命周期；`AccountSection` 保留默认视图。已有登录引导入口不能展示已登录状态与余额，因此增加这个可复用入口。Hemi 的 `DeepSeekSubscription` 适配原生状态、操作及余额格式化，`AccountSubscriptionCard` 读取已选型号，再进入共用卡片。登录凭据与侧边栏账号共享，退出沿用原生任务影响确认。
- 原生 `llm-deepseek-account` 增加通用可配置 `selectedModels`：默认 `null` 沿用全部可服务型号，空数组明确隐藏全部型号；型号筛选更新会通知原生目录。注册模型发现能力，重新读取全部可服务候选，允许重新添加已删除型号；拒绝替换端点、协议和凭据。`llm-deepseek` 缓存增加显式 `reload`，合并并发请求，保留失败前的可用目录并向发现调用方报告失败。LLM 模型发现请求的 JSDoc 改为由适配器决定缓存与请求策略。上游不导入 Hemi 代码，原生能力准入及默认运行策略保持原样。
- Hemi Host 通过提供方声明的设置路径持久化选择与 `modelOverrides`，不建立 Pi 同名路由。合并上游时核对账号 factory、访问权限、原生发现和目录缓存；若上游提供等价接口则评估移除对应扩展。相关目录与文档从声明重新生成。
- 验证：63 项原生目录／账号／订阅测试、15 项模型操作客户端测试、740 文件 GUI 回归通过；DeepSeek keyless 真实 Loader／浏览器 refresh 与 replay 覆盖登录、模型列表、工具调用、型号设置、删光并恢复、余额刷新、窄屏及退出。构建产物及 Host／Client 聚合检查通过；GLM keyless 真实 Loader／浏览器回归覆盖相同的额度刷新控件及型号管理。局部 lint 通过。首次文档检查 41／43 通过，余下两个为持久化目录行号过期；重新生成后持久化历史检查通过。再次 doc-sync 遇到本地文件读取阻塞，独立读取 `.git/config` 和无关包清单也超时，已停止本次检查，未计为全量通过。

## 2026-11-05 · 订阅拉取型号图标

- `packages/hemi/model-access-ui` 的订阅卡片将拉取型号入口移到重新授权之前，使用现有下载图标及本地化 Tooltip。`ModelPicker` 增加可选紧凑入口，继续使用原来的搜索、刷新和确认添加弹窗；API 连接保留文字入口。本次改动只在 Hemi 插件内。
- 验证：本包 TypeScript 编译与客户端 bundle、局部 lint、客户端操作测试、DeepSeek 真实 Loader／浏览器 refresh 与 replay 通过；390px 布局已检查。当前 Electron 的 DeepSeek、GLM 与 Codex 卡片均已显示图标入口。全仓聚合检查遇到并行改动中的缺失构建声明；doc-sync 检出其他目录过期及文档标记缺失。已停止余下全仓检查，未计为通过；本次文件的导出 JSDoc、配置目录、客户端目录及翻译配对检查通过。

## 2026-11-05 · 收起原生账号与模型导航

- 原生账号插件增加默认开启的通用 `showSettingsSection`、`showLauncher` 配置，只控制账号设置和侧边栏入口，不停用账号状态、登录、通知或 `account.connection`。桌面组合关闭这两个入口，并使用已有配置关闭原生「模型」入口；Web 默认行为保持原样。Hemi 的账号操作集中在「模型接入」订阅卡片中。合并上游时核对原生入口配置与权限生命周期，有等价接口时移除本地扩展。
- 验证：35 项账号配置与注册测试、Host／Client 聚合检查、隐藏导航的真实 Loader／浏览器验收通过。当前 Electron 已完整重启，确认账号 tab、模型 tab 和侧边栏用户信息均已隐藏，「模型接入」中的 DeepSeek 余额与型号仍可用。全量 GUI 首轮出现超时，9 个失败文件单独复查的 185 项全部通过。
- 提交检查保留全仓 `doc-sync` 失败记录：未改动的 README 章节和 Agent Notes 格式检查未通过。本批次局部 lint、浏览器验收及其重放通过；全量 GUI 首轮的 9 个失败文件复查全部通过。
