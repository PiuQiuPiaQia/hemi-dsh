# Hemi-DSH

[English](README.md) | 中文

<img src="packages/hemi/customizations/artwork/icon-macos.png" alt="Hemi 应用图标" width="88">

Hemi-DSH 是基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的开源桌面 AI 智能体。你可以接入自己的模型，为不同任务角色分配模型，并在会话之间保留记忆。

[下载 Hemi 桌面版](https://github.com/PiuQiuPiaQia/hemi-dsh/releases)

## 下载

打开 [GitHub Releases](https://github.com/PiuQiuPiaQia/hemi-dsh/releases)，选择最新的 nightly。已发布的桌面构建适用于 Apple Silicon 芯片的 Mac。在版本附件中下载以 `-mac-arm64.dmg` 结尾的安装包。

Hemi-DSH 处于开发者预览阶段。使用前请阅读[安全说明](SAFETY.zh.md)。

## 功能

- **模型接入**支持订阅账号、API Key 和 New API 站点。可以在桌面应用内登录 New API 站点，从列表中勾选模型并一键导入。[模型接入说明](packages/hemi/model-access-ui/README.zh.md)
- **模型路由**可指定主模型，并为研究、评审、执行和设计角色分配模型。[模型路由说明](packages/hemi/routing-ui/README.zh.md)
- **记忆**让上下文跨会话保留。可在设置中编辑长期记忆、每日日志和便签。[记忆说明](packages/hemi/memory-ui/README.zh.md)
- **备份与恢复**支持本地文件夹和 WebDAV。恢复前可预览备份与本地数据的合并结果。[备份说明](packages/hemi/backup-ui/README.zh.md)

<a id="run"></a>

## 运行

按[从源码运行](#run-from-source)启动 Web 界面，再打开启动器输出的地址。[Web 界面指南](docs/user/guide/index.zh.md)

<a id="run-from-source"></a>

### 从源码运行

克隆[本仓库](https://github.com/PiuQiuPiaQia/hemi-dsh)，按[开发指南](docs/development.zh.md)安装依赖、构建并启动 Web 或桌面版。

## 开发

Hemi 功能位于 [Hemi 插件及桌面适配](packages/hemi/README.zh.md)。运行时设计见 [DSH 架构文档](docs/architecture.zh.md)，仓库协作约定见 [CONTRIBUTING.md](CONTRIBUTING.zh.md) 和 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)。依赖许可见[第三方声明](THIRD_PARTY_NOTICES.md)。
