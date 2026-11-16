# dsh-pocket 源码与许可证

[English](README.md) | 中文

Hemi 按 `dsh-pocket` 自身的 [GPL-2.0 许可证](LICENSE)分发未修改的 npm 包。[source.tar.gz](source.tar.gz)随附完整上游源码，包含客户端源码和构建脚本。[upstream.json](upstream.json)记录对应的包版本、源码修订、压缩包摘要及 npm 完整性信息。

CLI npm 包以 `third-party/dsh-pocket` 路径携带本目录，Desktop 与 SDK 分发随 CLI 保留它。Desktop 还将其镜像到 `dsh/third-party/dsh-pocket`，与 `dsh/node_modules/dsh-pocket` 中安装的插件一同提供。源码压缩包供查看和修改；Hemi 不在应用启动时执行或重建其中内容。

实现由[上游项目](https://github.com/shaobeichen/dsh-pocket)维护，原有许可证与版权声明保持不变。更新预装 npm 版本时必须同时替换匹配的源码压缩包与元数据；运行时准备会拒绝版本或摘要不一致的输入。
