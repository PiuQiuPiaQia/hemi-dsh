---
kind: upgrade-guide
description: "Hemi 桌面包采用独立的应用名称、协议注册和默认数据目录。"
---

# Hemi 桌面身份

[English](guide.md) | 中文

## 变更

Hemi GitHub 桌面构建使用 `hemi-dsh.app` 或 `hemi-dsh.exe`、`hemi-dsh-<version>-<platform>-<arch>` 安装包，以及 `hemi-dsh://open` 外部协议。Electron 偏好设置使用平台应用数据目录下的 `hemi-dsh` 子目录，默认 Harness 数据目录为 `~/.hemi-dsh`。首个测试版本曾使用 DeepSeek Harness 名称和共享的 `~/.dsh` 默认目录。已有文件保留原处，不自动迁移账号、Session 或偏好设置。

应用标识 `ai.hemi.dsh.desktop`、固定签名证书、仓库和更新清单地址保持一致。内部 DSH 包和 `dsh` 引擎命令保留原名。未启用品牌标记的 DSH 构建保持默认行为。

## 迁移

1. 退出旧 Hemi 测试应用，手动安装一次新名称的 `hemi-dsh` 应用，使已安装的应用包文件名也随之改变。
2. 启动新应用，在“关于”中确认名称。新的默认配置使用 `~/.hemi-dsh`，按需重新设置账号和设备偏好。
3. 如果明确需要继续使用旧 Harness 数据目录，在启动前通过已有的 `DSH_HOME` 环境覆盖指定其绝对路径。先核对该目录由哪个应用使用。此覆盖只选择 Harness 文件，不迁移 Electron 偏好设置。
4. 在验证新安装前保留旧数据目录。之后的更新使用原有 nightly 或 stable 清单，并下载新名称的资产。
