# Agent Note: Preinstalled third-party Desktop bundles

Status: implemented

[English](2026-11-14-preinstalled-desktop-bundles.md) | 中文

## Problem

用户选择原版 dsh-pocket 和 dsh-mnemon，不再维护 Hemi 自研手机与记忆实现，并要求 Desktop 安装后即带有这两个插件，无需另行安装。启动必须支持离线、避免重复 bundle 条目，并保留已有配置和停用决定。

## Decision

CLI manifest 将两个原版 npm 包固定为安装依赖，包通过现有生产闭包随安装分发，内容不修改。只有 Desktop profile 准备会自动选择它们原有的 bundle 层。纯 Node [Hemi 适配器](../../../../packages/hemi/customizations/README.zh.md#preinstalled-plugins)在已有 Desktop profile 锁内，将已处理的 bundle 名称与选择结果原子写入同一个 profile manifest。profile 中已安装但未选择的包保持关闭；后续准备和恢复流程不重新开启已处理的 bundle。用户补丁、凭据、依赖声明和插件数据保持不变。

安装归属使两个 bundle 在插件管理器中持续可见并可启停，不提供卸载或独立版本替换。安装内固定版本优先于保留的 profile 本地副本。其他 CLI profile 携带依赖，但不自动启用这些 bundle。

Pocket 保留 GPL-2.0。用户明确选择该插件，因此通知检查仅允许这个包名与许可证组合，不放行一般 GPL 依赖。Desktop 随附未修改的许可证和匹配的完整上游源码压缩包，包含客户端源码和构建脚本。打包在封存运行时前核对压缩包摘要和已装版本。Mnemon 保留 MIT，两个插件都不改标为 Hemi 自有代码。

## Alternatives considered

- **首次启动时安装。** 这将网络与包管理器故障引入离线启动，并重复现有运行时准备职责。
- **将上游补丁复制进 Hemi Web bundle。** 这会重复代码归属，可能与单独选择的 bundle 冲突，并妨碍正常的按 bundle 停用。
- **维护自研替代实现。** 这恢复了用户明确不想维护的协议和界面；[手机功能移除决策](../simplification/2026-11-14-third-party-phone-access.zh.md)保留相关取舍。

## Consequences

Hemi 承担这两个插件带来的依赖体积和发版责任。预装版本随 Hemi 更新，不独立替换。Pocket 保留上游局域网、密码行为与已保存的隧道偏好；全新安装不会启动公网隧道。Mnemon 使用自己的存储和工具，不自动导入旧 Hemi 记忆文件。预装不代表上游代码已获安全认证。

## Testing

profile 测试覆盖一次性选择、已有停用状态、重启、恢复、畸形状态和用户文件保留。源码分发测试拒绝摘要或版本不匹配。真实浏览器场景加载两个原版 bundle、读取录制历史、确认公网隧道保持关闭，并验证两个插件卡片可管理。
