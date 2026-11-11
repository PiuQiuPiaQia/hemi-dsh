---
description: "面向组合 POSIX 文件、进程与沙箱提供方的部署者，说明 OpenSSH 连接配置及远端辅助进程生命周期。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh

[English](README.md) | 中文

## 概述

`dsh-ssh` 将 POSIX Harness 主机连接到 POSIX SSH 主机上已安装的辅助程序。部署方持有的 OpenSSH 主机别名提供认证与主机身份；配套的文件系统、子进程和沙箱提供方共享该连接。连接在就绪前验证已安装产物的摘要；辅助程序在连接关闭或租期到期时负责远端清理。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在自定义 `dsh` 配置组合中，将本服务与 [`fs-ssh`](../fs-ssh/README.zh.md)、[`subprocess-ssh`](../subprocess-ssh/README.zh.md) 和 [`sandbox-ssh`](../sandbox-ssh/README.zh.md) 组合。主机运行 Harness、模型传输和 Session 存储；远端机器提供文件与进程。headless 配置组合支持这种安排。

辅助进程验证线协议中的额外可写根目录；其执行限制的提供方要求使用远端文件系统中的物理目录路径。只读模式不授予这些目录的写权限。

### 部署前提

两端均需运行 Linux 或 macOS。服务器必须允许不分配 PTY 的 SSH exec 会话。借用 OpenSSH 主连接时，本地还需支持连接复用。启动前配置主机别名、凭据与已知主机记录，或通过 `authenticatedControlPath` 提供绑定到该端点的已认证连接：本服务启用 `BatchMode`、要求严格检查主机密钥、禁用认证代理转发，且不提供交互认证流程。

安装 [SSH helper 可执行文件发行包](../ssh-helper-runtime/README.zh.md)，或已构建的 helper 脚本及其匹配的 Node 依赖。运行时必须位于工作区和可写临时目录之外，也必须位于后端会替换的临时目录树之外，例如 bwrap 的私有 `/tmp`；工作区仍可位于 `/tmp` 下。摘要校验在辅助程序启动后发现非预期的已安装产物；它不能保证可写部署文件的执行安全，也不能认证恶意 SSH 主机。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `host` | 必填 | OpenSSH 别名、DNS 名、IPv4 或 IPv6 地址；兼容 `user@host` |
| `username` | 省略 | 显式登录名；不能与 `host` 中内嵌的用户名同时提供 |
| `port` | 省略 | 显式 TCP 端口，范围为 1 至 65535 |
| `identityFile` | 省略 | 本地私钥文件路径；本服务不读取密钥内容 |
| `authenticatedControlPath` | 省略 | 借用的已认证 OpenSSH 套接字绝对路径，由其所有者绑定到本端点；本消费者不持久化或终止主连接，套接字不可用时拒绝而不新建连接 |
| `launch` | 必填 | `{ kind: "executable" }`，或 `{ kind: "node-script", node: "/absolute/node" }` |
| `helper`、`workspace` | 必填 | 远端 helper 入口和默认工作区的绝对路径 |
| `executionTarget` | 省略 | 标记非默认环境的不可变引用；Hemi 为绑定目标的 provider 组提供此值 |
| `helperHash` | 必填 | 已安装辅助程序入口的小写 SHA-256 |
| `launch.bootstrapPath`、`launch.bootstrapHash` | 省略 | 成对提供的远端 PTC 脚本及摘要；仅用于 `node-script` |
| `requestTimeoutMs` | `30000` | 连接与管理请求的截止时限，范围为 1 至 2,147,483,647 毫秒 |
| `maxFrameBytes` | `67108864` | 每条 JSON 消息的负载上限，最大为 64 MiB |
| `maxPending` | `128` | 普通未完成请求的数量上限；心跳与有界清理请求使用预留容量 |
| `leaseMs` | `30000` | 辅助进程心跳租期，范围为 3000 至 600000 毫秒 |

将验证后的 `ctx.ssh.ptcLaunch` 作为 [`NodePtcRuntime`](../../ptc-runtime/ptc-runtime-node/README.zh.md) 的 `launch` 配置。可执行文件部署包含 worker；脚本部署使用 PTC 时需要两个引导字段，仅使用文件系统和 Bash 时可以省略。脚本引导未配置时，getter 会拒绝访问。客户端在就绪前拒绝不匹配的协议版本、运行形式和 helper 摘要。

-----

<a id="understand-the-implementation"></a>
## 理解实现

辅助进程通过其沙箱文件系统提供方分派 `fs.patch`、`fs.delete` 和 `fs.move`；严格 schema 校验 hunk、源/目标防护，以及完整或部分的移动结果。hunk 负载使用连接帧上限。

<details>
<summary>实现细节 — 点击展开</summary>

已认证的 SSH exec 通道承载 helper 的私有管理 RPC 和子进程流。helper 在接受启动请求前，在该连接上预留每条流。程序字节封装在二进制帧中，每条流拥有独立接收窗口。管理帧可以在大小有上限的数据帧之间发送。使用 `authenticatedControlPath` 时，主连接由外部所有者持有。

连接释放会请求远端清理，并等待 SSH exec 子进程退出。传输丢失会拒绝待处理操作、中止 `ctx.ssh.signal` 并使连接失效。辅助进程在 SSH EOF、终止信号或心跳到期时启动托管清理。断连客户端无法确认远端结果；操作不会自动重连或重放。

启动或进程结果失败后，预留项在原生进程范围清空后释放；有界完成缓存保留原始拒绝结果，供后续读取。辅助程序关闭也会等待已在进行的流清理。

终端启用 shell 活动观察时，根进程退出会保留 reservation 及其剩余工作。活动 RPC 继续访问 provider；明确终止时先等待进程范围完全停稳，再释放端点并记录完成结果。helper 连接卸载和租约到期仍保留原有的终止权限。

连接会禁用 helper 的 SIGUSR1 调试器激活：脚本调用使用 `--disable-sigusr1`，可执行文件调用通过 `NODE_OPTIONS` 提供该标志。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) — 执行坐标、传输语义及生命周期归属。
- [POSIX SSH 决策](../../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md) — 理由、替代方案及必要验证。

-----

<a id="model-experience"></a>
## 模型体验

无，因为主机别名、认证与流能力令牌属于私有部署细节，每项面向模型的操作均由消费方负责。

#### KV Cache 影响

本提供方不贡献请求前缀内容。面向模型的工具与结果由消费方负责。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 不提供 Windows 端点、自动配置远端环境、重连或重放。
- 远端预览读取需要限定于 Session 的 [workspaceFiles](../../api/workspace-files/README.zh.md)。仅本地的[文件建议](../../context/file-reference-local/README.zh.md)和原生 Host 应用交接不列举或打开远端路径。
- 远端操作系统与 helper 进程处于信任范围内。文件效果策略保留所选沙箱后端的限制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
