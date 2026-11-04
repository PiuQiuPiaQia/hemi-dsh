# Hemi fork 改动账本（hemi-fork-changes）

纪律：所有对上游拥有文件的改动逐条登记，便于 `git merge upstream/master` 时定位冲突面。我们自己的新文件（packages/client/ui-hemi-skins/**、packages/hemi/memory/**、packages/hemi/routing/** 等）不算上游改动，但登记在建包记录里。

**⚠️ 关键规则（踩坑实证）：凡通过 preset 行 / patch 行引用的插件（含 host 工具包），其包名必须出现在 `packages/bundle/web-app/package.json` 的 dependencies（resolver manifest）里，否则行解析失败、会话创建报 `agent-preset/invalid: <id>: never started`（构建门禁不拦此错，只在运行期暴露）。**

## 2026-11-04 · 角色路由插件（hemi-routing）

新增自有包：
- `packages/hemi/routing/`：host 提示词插件。Config = `roles: {角色名 → {provider, model, reasoningEffort?}}`；apply 把角色→路由表渲染成系统提示词段（锚定 TOOL_SUBAGENT 段序），指导主代理在 subagent 委派时按角色显式传 provider/model，未列角色继承父路由，路由被会话策略拒绝时回退。路由权威仍在 Plugins 页"子代理"设置（allowedModels 会话策略），本插件只做角色语义层。

改动的上游文件（2 处）：
1. `tsconfig.host.json`：references 增加 `{ "path": "./packages/hemi/routing" }`。
2. `packages/bundle/web-app/presets/standard.patch.yml`：persona 行后新增 `hemi-routing` 行（示例角色表指向当前默认路由，用户按需改）。
3. `packages/bundle/web-app/package.json`：dependencies 增加 `@deepseek-ai/dsh-hemi-routing: workspace:*`（resolver manifest——必需，见顶部规则）。

同时补记：hemi-memory 的 resolver manifest 行（`@deepseek-ai/dsh-hemi-memory: workspace:*`）——之前提交 bcee7f495c 漏了它，导致该插件的 preset 行一直 "never started"（本次发现并修复）。

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
