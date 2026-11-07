# Hemi-DSH

[English](README.md) | 中文

<img src="packages/hemi/customizations/artwork/icon-macos.png" alt="Hemi 应用图标" width="88">

Hemi-DSH 是基于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的开源桌面 AI 智能体，面向想用自己选择的模型做研究、写代码和做设计的用户。

[下载 Hemi 桌面版](https://github.com/PiuQiuPiaQia/hemi-dsh/releases)

## 为什么用 Hemi-DSH

- **把已有的模型接到一起。** 在同一页管理订阅账号、API Key 和 New API 站点。New API 可以在 Hemi 内登录，从列表勾选模型后一键导入。[模型接入说明](packages/hemi/model-access-ui/README.zh.md)
- **给不同任务分配不同模型。** 用常用模型负责主对话，另选模型做研究、评审、执行或设计。每个会话都可以在自动路由和固定模型之间切换。[模型路由说明](packages/hemi/routing-ui/README.zh.md)
- **换个会话也能接着做。** Hemi 会在新会话中读取已保存的记忆和每日日志。你可以在设置里查看和修改这些内容。[记忆说明](packages/hemi/memory-ui/README.zh.md)
- **自己决定备份存在哪里。** 将会话和记忆备份到本地文件夹或 WebDAV，恢复前可以预览与本地数据的合并结果。[备份说明](packages/hemi/backup-ui/README.zh.md)

## 下载

打开 [GitHub Releases](https://github.com/PiuQiuPiaQia/hemi-dsh/releases)，选择最新的 nightly。已发布的桌面构建适用于 Apple Silicon 芯片的 Mac。在版本附件中下载以 `-mac-arm64.dmg` 结尾的安装包。

Hemi-DSH 处于开发者预览阶段。使用前请阅读[安全说明](SAFETY.zh.md)。

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
