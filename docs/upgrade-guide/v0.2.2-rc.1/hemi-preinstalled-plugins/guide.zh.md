---
kind: upgrade-guide
description: "Hemi Desktop 将 dsh-pocket 和 dsh-mnemon 作为随版本提供的 bundle，无需用户在 profile 中另行安装。"
---

# Hemi Desktop 预装第三方插件

[English](guide.md) | 中文

## 变更

Hemi Desktop 携带原版 `dsh-pocket` 和 `dsh-mnemon` 包。新建或升级后的 profile 首次准备时，一次性选择它们的 bundle 层；若 profile 依赖已记录某包安装但未选择，则保持关闭。后续启动和恢复流程不重新开启用户已关闭的 bundle。

安装内固定版本优先于 profile 本地副本。预装文件不能通过 profile 包管理卸载或替换，版本随 Hemi 更新。已有 profile 依赖、插件配置和数据保留。不导入旧 Hemi 记忆或手机配对数据，全新安装不会启动公网隧道。

## 迁移

1. 升级前退出 Hemi，无需执行插件安装命令。如果曾将上游 bundle 的 `insert` 块手动复制进自定义补丁，请移除复制的块以免条目 ID 重复；保留普通 `- id:` 覆盖配置。
2. 打开插件页，确认列出 `dsh-pocket` 和 `dsh-mnemon`。已有停用状态保持关闭，可通过各 bundle 开关选择状态。需要停用时关闭 bundle，不要尝试卸载签名运行时中的文件。
3. 通过原版插件配置手机访问或记忆功能。Hemi 保留它们已有的偏好和凭据，公网访问仍由用户单独开启。Pocket 原始 GPL-2.0 许可证及匹配的完整源码随[源码分发目录](../../../../apps/cli/third-party/dsh-pocket/README.zh.md)提供。
