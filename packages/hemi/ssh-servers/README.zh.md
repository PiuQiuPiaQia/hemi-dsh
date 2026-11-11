---
description: "保存 SSH 连接、浏览远端目录，并为远端工作区准备执行运行时。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-ssh-servers

[English](README.md) | 中文

## 概述

保存命名的 SSH 服务器，并在重启后保留主机、端口、登录名和私钥路径引用。编辑或移除前必须提交记录的版本，避免旧编辑覆盖新记录。保存服务器不会连接主机、安装软件、读取私钥或改变本地 Workspace。独立的 `workspaces` 入口验证真实远端目录，并为普通 Workspace 创建登记不可变执行目标。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Hemi Desktop 将本服务与 [SSH 服务器界面](../ssh-servers-ui/README.zh.md)一起组合；其他 profile 默认禁用。服务器登记入口没有配置字段，需要已有后端配置的[领域存储服务](../../storage/storage-domain/README.zh.md)。

名称和主机不得为空，端口为 1 到 65535 之间的整数。登录名和私钥路径留空时使用 OpenSSH 配置。保存的记录不包含密码或私钥内容。可选的远端绝对 `directory` 仅表示浏览起点，同一连接仍可打开多个工作区。保存引用不验证 SSH 访问。

挂载 `@deepseek-ai/dsh-hemi-ssh-servers/workspaces`、Session store 及沙箱策略。两端须支持 POSIX OpenSSH。原生 OpenSSH askpass challenge 处理密码、私钥口令和明确的首次主机信任；主机密钥变化时拒绝连接。响应不进入日志或连接记录。

符合条件的已保存连接，其目标主机密码提示提供默认不勾选的“记住密码”。所选密码仅在认证成功后通过可选的[凭据提供者](../../credentials/credentials-local/README.zh.md)保存；默认提供者以明文写入 `$DSH_HOME/.credentials.yaml`，并设置仅所有者可读写的权限。复用要求主机、登录名、端口、私钥路径及原生提示中的登录名完全匹配。已保存密码被拒后转为手动输入，不重复自动提交。若随后还有认证提示，本次密码保存选择作废；多因素验证提示仍需手动回答。私钥口令、一次性验证码、跳板机提示及其他响应仍仅临时使用。修改名称保留密码；修改端点或移除使用该端点的最后一个已保存连接时清除密码。密码写入失败会关闭新连接并报告保存结果未确认；清理失败会说明服务器变更已持久化，并在服务重启时重试清理。

Host 实例为主机、登录名、端口和私钥路径完全相同的组合保留前台已认证主连接，供目录读取和执行通道复用。challenge 所有权和取消规则见[认证语义](../../../docs/subsystems/hemi.zh.md#ssh-authentication)。

`/workspaces` 入口接受下列配置，每项均为 1 到 2147483647 之间的整数；它们不改变已保存的连接或 SSH 配置文件。

| 配置 | 默认值 | 作用 |
|---|---|---|
| `authenticationTimeoutMs` | 120000 | 以毫秒约束连接建立、所有提示和就绪过程。 |
| `serverAliveIntervalSeconds` | 10 | 保留主连接的 OpenSSH 存活探测间隔，单位为秒。 |
| `serverAliveCountMax` | 3 | 连续探测无响应达到此次数后，OpenSSH 断开；后续操作可以重新认证。 |
| `runtimeProvisionTimeoutMs` | 300000 | 整个远端 Node 供给操作允许的毫秒数，包括平台探测、下载、上传与校验。 |

`browseServer` 和 `browseSavedFolders` 使用已认证 SSH 连接，不要求远端运行时，也不写入远端；空路径解析远端主目录。取消登录不会启动所请求的目录或执行操作。已确认的首次信任可能保留在 OpenSSH 已知主机文件中。

`prepareServerFolder` 核对所选端点，在应用自有的远端缓存中准备随包提供的版本化执行文件，并验证所选物理目录后返回持久执行引用。helper 运行在 Hemi 自行供给的 Node 上：固定版本的官方 Node.js 构建在本机完成校验后上传到同一缓存并跨连接复用；服务器上已有 PATH 中的 Node.js 24 或更高版本时优先使用。服务器无需预装 Node；Linux 需要 glibc 2.28 或更高，过老 glibc 或 musl 系统仅警告不拒绝。除该缓存外不写入任何位置，也不修改 SSH 配置。执行文件必须位于可写工作区之外。将返回的路径和执行引用交给 `workspace.create`，不能伪造 Workspace id。编辑或删除连接不会重写已有目标快照。`configureRuntime` 及按部署版本操作的接口也支持明确安装的部署。

恢复已保存的 Workspace 或 Session 时，使用旧版 Hemi 自动供给产物的目标会改用当前安装包自带的 helper。部署缓存按内容寻址，已保存的执行引用仍标识原服务器及物理目录。

组合 Workspace Controller 时，只读显示投影将已有和新建 SSH 工作区显示为 `文件夹名称（连接名称）`；自定义工作区标题保留其文字，并仅追加一次相同的连接后缀。显式执行引用选择不可变目标快照，不通过相同的本地路径推断身份。已保存连接的 id、主机、登录名、端口和私钥路径均与快照相同时使用其当前名称，因此纯改名会更新显示；删除连接或更换端点后回退到快照名称。只有已注册工作区在最终名称和目录均相同、但主机、登录名或端口不同时，才显示 `文件夹名称（连接名称 · user@host:port）`。显示名称不修改已保存工作区标题、会话数据或执行目标；重命名草稿使用已保存标题。连接和工作区变化会刷新活跃的 Workspace 订阅者。快照缺失时显示显式 provider 和目标 id，不假定为本地目录。

Remote 服务使用 Gateway 的全局资源访问策略。记录不是 Workspace 或 Session 资源，因此分享会话不会授予此目录的访问权。输入无效、记录已移除、版本过期均以结构化拒绝返回；存储失败不产生界面成功提交。存储结果未知时，应重新打开已隔离的领域，而不是盲目重试写入。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[领域声明](src/spec.ts)验证整个已保存目录，名称为 `hemi_ssh_servers`，版本为 1。一个原子文档包含按创建顺序排列的记录。[服务](src/index.ts)串行处理修改，检查记录版本，只返回已持久化结果。卸载时停止接收操作，等待已接受的操作结束，再关闭领域。[工作区服务](src/workspaces.ts)在 `hemi_ssh_workspaces`（版本 1）中保存部署配置及只追加的端点／目录快照。池为每个存活实例分配独立身份，并为 SSH、FS、子进程、沙箱、shell 与 PTC 分配六个不同 Cordis 服务标签；Host provider 保持不变。最后一个借用方先等待消费者结束，再关闭 provider 组。PTC 使用已验证的 `ssh.ptcLaunch`，不选择 Host Node 路径。

仅供 Host 使用的 `SshAuthenticationPasswordMemory` 协作接口按完全匹配的 `SshPasswordEndpoint` 读取、提交和丢弃密码授权记录；这两个类型均不属于 Remote 响应 API。凭据操作共用目录的写入队列。依赖作用域内的凭据绑定先等待队列完成，再释放提供者；原生认证在销毁时另行等待提示查询及已接受密码的写入结束。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 服务器界面](../ssh-servers-ui/README.zh.md)——持久连接选择器、编辑器和远端目录选择。
- [Hemi 子系统](../../../docs/subsystems/hemi.zh.md)——生成的服务接口。
- [SSH 运行时](../../ssh/ssh/README.zh.md)——独立的远程执行和部署要求。

-----

<a id="model-experience"></a>
## 模型体验

无，因为服务器登记不添加工具、提示词分区或 Session 事件。

#### KV Cache 影响

无；目录操作不组装模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 认证使用 POSIX OpenSSH 原生提示；应用重启或已认证连接断开后可能需要重新登录。目录浏览不需要服务器上有运行时。远端执行使用 Hemi 供给到自有缓存的 Node（或服务器上已有的 Node.js 24+）；glibc 低于 2.28 的 Linux 及 musl 系统（如 Alpine）仅警告，但可能无法运行。
- 私钥路径仅是引用；服务不读取或验证所指文件。
- 存储领域归单一进程所有，独立 Host 进程之间不交换实时更新。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
