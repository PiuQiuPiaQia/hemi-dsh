---
kind: upgrade-guide
description: "SSH 客户端和已安装的 helper 必须使用匹配的协议 4，才能通过 SSH exec 通道传输子进程流。"
---

# 将 SSH 客户端和 helper 升级到协议 4

[English](guide.md) | 中文

## 变更

协议 3 使用各自转发的 Unix 套接字和 TLS-PSK。协议 4 通过已认证的 SSH exec 会话传输管理请求和子进程流。连接要求使用匹配的 helper，并在接收任务前验证安装产物的摘要。

## 迁移

1. 在 Hemi Desktop 中恢复由 Hemi 管理 helper 的 Workspace 或 Session，将新的随包产物部署到保存的服务器。
2. 如果手动安装 helper，将匹配的脚本 bundle 或完整的可执行文件归档安装在原有部署旁边。将 `helper` 和 `helperHash` 指向安装入口及其摘要。脚本 helper 如使用 PTC，同时更新 `launch.bootstrapPath` 和 `launch.bootstrapHash`。见 [SSH 部署](../../../../packages/ssh/ssh/README.zh.md#use-this-package)。
3. 重新打开连接，读取一个远端文件并通过 Bash 执行 `true`。使用 PTC 或终端的部署可以在同一连接中运行平常使用的命令进行验证。
