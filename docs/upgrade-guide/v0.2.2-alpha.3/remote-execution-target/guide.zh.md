---
kind: upgrade-guide
description: "较旧的 Harness 构建会拒绝记录了显式执行目标的 Session。"
---

# 保留 Session 记录的执行目标

[English](guide.md) | 中文

## 变更

Session 可以在 header 中记录不可变的 `executionTarget`。即使目录路径相同，该引用也能区分不同的执行环境。较旧构建会拒绝此 header 字段，可能报告 header 无效或损坏，而非功能不受支持。没有该字段的 Session 保留现有表示。Workspace 存储使用领域版本 3 保存同一引用；读取兼容版本 2，写入标记为版本 3。较旧 Workspace 读取器会拒绝该版本，而不是把远端路径解释成 Host 目录。

显式执行目标不继承部署默认环境的额外可写根，也不接收它的 `DSH_HOME` 与 `DSH_PROFILE_DIR` 路径。绑定目标的 SSH provider 会拒绝携带这些额外根的逐次调用策略。搜索使用目标 PATH 中的 `rg`；随包二进制只在 Harness 所在机器使用。

## 迁移

1. 用理解 [`SessionHeader.executionTarget`](../../../subsystems/persistence.zh.md#sessionheader--metadata-beside-the-log) 的构建打开带目标的 Session。将 Workspace 领域、provider 配置和不可变目标记录与 Session 数据一同保留。在使用会写入 Workspace 版本 3 的构建打开数据前保留备份。
2. 若目标不可用，恢复对应执行环境。不要删除 `executionTarget`，也不要将它替换成本地目录以强行恢复。
3. 插件作者通过 `ctx.sessions.registerExecutionProvider` 注册 provider。Agent setup 中向 preset 的 `mount`、`recompose` 或 `composeFrom` 传入 `agent.execution`；不要从携带 Agent 作用域的 Context 激活远端共享插件。
4. 自定义 subprocess provider 的 `resolveExecutable` 接收 `SubprocessExecutable`：普通字符串保持原查找语义；随包资源提供逻辑命令与惰性的 `resolveLocalPath`。仅在同机 provider 调用该定位函数。远端 provider 只在自己的环境中解析逻辑命令。
5. 为无 Agent 的目标策略解析提供已验证的执行环境工作区。不要把部署的 `additionalWritableRoots` 复制到目标调用。使用搜索时，在远端 PATH 安装 `rg`；缺少程序时失败，不在本地执行。
6. 直接调用 WorkspaceFiles 时，必须保留 `WorkspaceFileScope.executionTarget`（默认环境显式传 `undefined`）。Session 来源的媒体与原生请求携带 `sessionId`；目录启动可携带 `workspaceId`。原生打开要求已验证的 Host 映射，同名远端路径不算映射。
7. 自定义建议菜单视图需处理不可选的 `failed` 分组；来源失败不等于成功返回空结果。
8. 确认重新打开或导出 Session 后，provider 和目标 id 均保持不变。被拒绝的恢复不得改动存储日志，也不得启动本地执行。
