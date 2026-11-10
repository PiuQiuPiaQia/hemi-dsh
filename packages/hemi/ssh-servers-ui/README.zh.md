---
description: "在 Hemi 工作区选择器中保留 SSH 连接，并将已验证的远端目录打开为真实工作区。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-ssh-servers-ui

[English](README.md) | 中文

## 概述

保存 SSH 连接，之后可从会话内的工作区选择器反复选择。先选择连接，再浏览并打开真实远端目录。侧栏按目录列出工作区及其会话，不固定列出已保存服务器。仅保存连接信息不会启动 SSH 或改变所选工作区。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在会话工作区选择器或侧栏添加菜单中，选择“添加工作区”下方的“添加 SSH”。表单包含显示名称、单个 SSH 地址、单独的端口、可选私钥路径和可选首选远端目录。地址支持“用户名@主机”和 OpenSSH 别名。私钥保留在 Hemi 主机上，字段接受路径，不接受私钥内容。

编辑器保留可选的首选目录字段。“选择目录”按当前编辑的端点打开与已保存连接相同的目录选择器。选择物理目录后填入字段；留空时从远端主目录开始。

选择已保存连接后，从首选目录或远端主目录打开目录选择器。选择器分为服务器标识、位置栏、位置快捷入口、可滚动文件夹区域和确认操作。可以点击文件夹进入，使用主目录或首选目录快捷入口，也可在位置栏填写绝对路径。同一端点在本次界面生命周期内最多保留三个已访问位置。只有显示的位置读取成功后，“使用此文件夹”才准入并选择真实工作区；加载、读取失败或尚未提交的路径编辑均不能选用旧结果。同一连接可打开多个目录。

工作区下拉菜单、已选工作区按钮和侧栏使用后端的 [SSH 显示名称](../ssh-servers/README.zh.md#use-this-package)，包括本次界面挂载前已注册的工作区。同一连接中的同名目录还会在下拉与侧栏显示可区分的路径后缀。完整长名称可通过名称提示和悬停详情查看；无 hover 时，打开下拉菜单或展开远端工作区会完整显示名称。本地工作区名称保持不变。

只有 OpenSSH 请求响应时才显示 SSH 登录。符合条件的目标主机密码提示提供可选的“记住密码”，每个新提示默认不勾选，包括已保存密码被拒后的重试。Host 仅在 SSH 认证成功后，将密码以明文保存到本机 DSH credentials 文件，权限为 0600（仅当前用户可读写），不使用系统钥匙串。私钥口令、一次性验证码、其他非密码响应和取消操作均不保存。如果登录成功后密码保存失败，Host 会关闭本次连接；可不勾选记住后重连，或检查 DSH 凭据库访问权限。

右键菜单沿用工作区样式，并在其后保留所点连接。聚焦行后也可按菜单键或 Shift+F10。Escape 先关闭操作菜单，再关闭底层选择器。删除仍需确认，不影响工作区和远端文件。

如果连接信息已变更但密码清理失败，列表会刷新，弹窗保留警告并禁止重复提交。请重启 Hemi 以重试清理，再关闭并刷新列表。

将 UI 插件与 `dsh-hemi-ssh-servers`、其 `/workspaces` 入口及标准工作区、语言、资源、Remote 访问、右键菜单和布局提供者一起挂载。Hemi Desktop 默认组合，其他 profile 按需启用。界面不暴露执行环境字段。目录读取通过 SSH 连接而不安装文件；打开工作区时才由 Host 准备随包提供的执行文件。SSH 配置文件和本地目录选择保持不变；首次主机信任需明确确认。参见后端的[使用前提](../ssh-servers/README.zh.md#use-this-package)。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>内部实现——点击展开</summary>

Client 只在临时草稿中合并 SSH 地址，Host 分开保存主机、用户名和可选的首选目录。列表、编辑目录和已保存目录的读取都使用资源模型。编辑中的端点变更会使旧浏览器失效；读取失败保留旧数据，但不允许选择。只有成功的 `prepareServerFolder` 结果进入普通工作区准入，原选择器只接收返回的 Workspace id，不接收连接或目标 id。Host 权限、端点版本和物理目录验证保持权威。

同一个注册的根级交互 store 在菜单和浮层之间共享编辑请求、草稿、通知和最近访问位置；位置历史按主机、登录名、端口和私钥路径隔离，不持久化。权威列表、目录结果和认证 challenge 保留在资源模型中。登录响应仅在按 challenge id 隔离的提示表单中保留到发送时，并在提交或断线时清空，不进入共享 store、资源值或已保存连接记录。记住选项仅适用于本次提交；认证成功后的密码存储由 Host 负责。Gateway 管理 challenge 流的重连；连接恢复或下一次目录请求会重新打开其资源。关闭远端读取会中止请求并抑制迟到导航。已发出的工作区写入可能在关闭后提交，因此通知要求先核对列表。卸载撤回注册，等待已发起操作结束后才移除 Remote；Host 保存的记录保留。

源码归属：[注册](src/client/mount.ts)、[连接请求](src/client/controller.ts)、[目录请求](src/client/folder-controller.ts)、[交互 store](src/client/store.ts)、[连接选择器](src/client/ConnectionPicker.tsx)、[目录弹窗](src/client/FolderOverlay.tsx)和[登录提示](src/client/AuthenticationOverlay.tsx)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [工作区](../../client/ui-workspace/README.zh.md)——侧栏所有权和原生目录选择。
- [客户端资源](../../../docs/subsystems/client-resources.zh.md)——共享资源读取和生命周期。
- [Web 客户端插槽](../../../docs/subsystems/slots.zh.md)——界面组合和共享交互 store。

-----

<a id="model-experience"></a>
## 模型体验

无；本包不贡献工具、提示词、会话事件或模型可见内容。

#### KV Cache 影响

无；本包不组装模型请求。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

远端选择有以下限制：

- 保存连接时不解析 SSH 别名，也不检查主机和私钥路径是否存在。
- 其他窗口的改动在刷新连接列表、本窗口成功写入、连接恢复或重新打开其资源时可见；没有 Host 变更推送。
- 两端必须支持 POSIX。未选择记住的登录响应仅临时使用；应用关闭、SSH 连接断开或已保存密码被拒后可能需要重新登录。远端执行前提由后端说明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
