---
description: "订阅授权、额度查询和 New API 模型导入的宿主操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-model-access

[English](README.md) | 中文

## 概述

Profile 所有者可以通过 Harness OAuth 连接 ChatGPT Codex、Claude 和 GitHub Copilot，也可以通过迁移自 Hemi 的授权流程连接 GLM Coding Plan。ChatGPT Codex 和 GLM Coding Plan 提供额度查询。桌面端的 New API 导入使用隔离的内嵌登录视图核验站点账号，按分组读取模型，再按用户确认的计划创建令牌。用户也可以手动导入已有令牌。

## 目录

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

DeepSeek 账号目录查询委托给已注册的 `deepseek-account` 适配器，保留其鉴权和模型准入策略。已选型号从原生适配器读取，拉取操作则重新加载完整目录。添加和删除型号只写入该提供方的 `selectedModels`，不修改凭据；删除最后一个型号会保存空列表。模型编辑写入该提供方声明的设置命名空间下的 `modelOverrides`，输入类型对应 `inputModalities`；不创建 Pi 提供方，也不替换账号目录。

断开订阅会删除其授权并清除该授权选中的型号，因此重新连接账号前该提供方不提供任何型号。GLM 的选择从 `subscriptionModels.bigmodel` 移除；其他订阅路由从 `llm-pi-ai` 配置中移除，但若该路由由 API key 引用，则保留路由及其型号，因为它们服务于该 API 连接。

模型能力编辑使用打开编辑器时读取的设置版本，保留无关模型字段。API 和 Pi 订阅模型的覆盖值保存在 `llm-pi-ai` 中；Hemi 自有 GLM 适配器从本插件设置的 `subscriptionModelOptions.bigmodel` 读取覆盖值。移除可选字段可恢复适配器默认值。改动影响后续模型解析，已经准备的请求保留原模型配置。

导入的 API 模型按完整 ID 从已安装目录继承名称、输入类型及 token 容量。优先采用 OpenAI 和 Anthropic 的原厂条目；其他匹配须使用相同协议且能力一致。未知或存在歧义的 ID 保留连接默认值。临时 `catalogProvider` 引用保留显式覆盖，不引入原厂接口地址、鉴权、兼容选项或请求输出上限。已有连接使用相同解析，无需重写已保存设置。

其他订阅型号在每次打开或刷新时重新请求服务端，查询失败不会用内置目录替代。Codex 使用登录账号的 `/backend-api/codex/models` 接口，Claude 和 Copilot 请求各自的鉴权型号接口。GLM 通过 `/api/v1/client/configs` 和公共 CDN 读取官方在线 ZCode Coding Plan 目录；这是公布的个人／团队套餐目录，不是逐账号权益校验。公共目录请求不携带账号凭据。响应不兼容或服务不可用时保留已有型号选择。`subscriptionDiscovery` 可配置请求时限、目录数量上限和外部 Codex／ZCode 客户端版本。

桌面端 New API 导入根据站点声明选择模型的请求协议；同时声明 OpenAI Chat Completions 和 Anthropic Messages 时，优先使用前者。保存前使用新令牌验证所选协议。

远程请求与响应字段由 [`src/types.ts`](src/types.ts) 定义。

排查 Codex WebSocket 中断时，可在 `$DSH_HOME/logs/codex-websocket.jsonl`（Hemi 桌面默认是 `~/.hemi-dsh/logs/codex-websocket.jsonl`）中按会话 ID 搜索。SDK 首次报告 WebSocket 故障时创建该文件。每行记录路由、时间、是否已开始流式输出、可用的关闭码和 SDK 最终结果，包括是否改用 SSE。本地日志不包含提示词、令牌或原始关闭原因。文件写入失败时，宿主日志会接收脱敏后的诊断。删除文件即可清除旧记录。

配置型号既没有内置目录记录、也未声明推理档位时，`reasoningFallbacks` 按协议补齐候选项：OpenAI Chat Completions 和 Responses 默认 `medium`，Anthropic Messages 默认 `high`。显式档位、显式禁用和内置目录记录优先。默认值同时用于选择器和实际请求，不改写已保存的连接。Anthropic 的补齐型号默认使用自适应思考，显式配置仍优先。

## 模型体验

<a id="model-experience"></a>

### 导入验证

#### 模型看到的内容

`New API` validation sends short independent requests to the selected model and protocol before saving routes. Account authorization and quota queries contain no conversation history.

#### Token 影响

显式验证消耗提供方 token；账户状态与额度查询不调用模型。

#### KV Cache 影响

验证使用独立请求，不替换对话前缀；修改导入路由可能改变后续提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 浏览器辅助导入需要桌面端及可用的加密存储。其他客户端可以导入已有的 New API 令牌。Claude 和 GitHub Copilot 显示授权状态。

### 开发备注

<a id="dev-note"></a>

无。
