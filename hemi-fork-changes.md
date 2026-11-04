# Hemi fork 改动账本（hemi-fork-changes）

纪律：所有对上游拥有文件的改动逐条登记，便于 `git merge upstream/master` 时定位冲突面。我们自己的新文件（packages/client/ui-hemi-skins/** 等）不算上游改动，但登记在建包记录里。

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
