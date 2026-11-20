---
description: "订阅授权、额度查询和 New API 模型导入的宿主操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-model-access

[English](README.md) | 中文

## 概述

Profile 所有者可以登录 VVCode、ChatGPT Codex、Claude、GitHub Copilot 和 GLM Coding Plan。VVCode 并列展示全部获准分组，每组拥有独立的模型 Key 与勾选。ChatGPT Codex 和 GLM Coding Plan 提供额度查询。桌面端 New API 导入会核验隔离视图中的站点登录、读取分组模型，并按确认的计划创建令牌；用户也可以手动导入已有令牌。

## 目录

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

DeepSeek 账号目录查询委托给已注册的 `deepseek-account` 适配器，保留其鉴权和模型准入策略。已选型号从原生适配器读取，拉取操作则重新加载完整目录。添加和删除型号只写入该提供方的 `selectedModels`，不修改凭据；删除最后一个型号会保存空列表。模型编辑写入该提供方声明的设置命名空间下的 `modelOverrides`，输入类型对应 `inputModalities`；不创建 Pi 提供方，也不替换账号目录。

断开订阅会删除其授权并清除该授权选中的型号，因此重新连接账号前该提供方不提供任何型号。GLM 和 VVCode 的选择从 `subscriptionModels` 移除；VVCode 还会清除全部自有分组绑定、Key 引用及模型覆盖项。其他订阅路由从 `llm-pi-ai` 配置中移除，但若该路由由 API key 引用，则保留路由及其型号，因为它们服务于该 API 连接。

模型能力编辑使用打开编辑器时读取的设置版本，保留无关模型字段。API 和 Pi 订阅模型的覆盖值保存在 `llm-pi-ai` 中；Hemi 自有 GLM 和 VVCode 适配器从本插件设置的 `subscriptionModelOptions` 读取各自的覆盖值。移除可选字段可恢复适配器默认值。改动影响后续模型解析，已经准备的请求保留原模型配置。

导入的 API 和 VVCode 模型按完整模型 ID 继承名称、输入类型、token 容量和推理能力，不依赖连接的提供方名称。显式 `catalogProvider` 选择能力来源；自动匹配存在歧义时保留连接默认值。模型显式覆盖优先。能力继承不会替换连接的接口地址、鉴权或请求头，继承的输出容量也不会设置请求输出上限。已有连接使用相同解析，无需重写已保存设置。

其他订阅型号在每次打开或刷新时重新请求服务端，查询失败不会用内置目录替代。Codex 使用登录账号的 `/backend-api/codex/models` 接口，Claude 和 Copilot 请求各自的鉴权型号接口。GLM 通过 `/api/v1/client/configs` 和公共 CDN 读取官方在线 ZCode Coding Plan 目录；这是公布的个人／团队套餐目录，不是逐账号权益校验。公共目录请求不携带账号凭据。响应不兼容或服务不可用时保留已有型号选择。`subscriptionDiscovery` 可配置请求时限、目录数量上限和外部 Codex／ZCode 客户端版本。Codex 目录请求以 `subscriptionDiscovery.codexClientVersion` 声明客户端版本，后端会略过最低客户端版本高于该值的模型。

桌面端 New API 导入根据站点声明选择模型的请求协议；同时声明 OpenAI Chat Completions 和 Anthropic Messages 时，优先使用前者。保存前使用新令牌验证所选协议。

VVCode 使用浏览器 PKCE 授权及本机回环回调。管理 PAT 保存在凭据库中；推理使用每组独立的模型 API Key，并始终携带 `X-AI-App: hemi-dsh`。目录读取并列展示全部获准分组及其只读模型目录——`GET /api/desktop/groups?app=hemi-dsh` 加上对每个分组的一次 `GET /api/user/models`（使用 PAT 的 `profile:read` scope）——因此无需任何 Key 即可浏览和勾选全部分组：读取不创建令牌或 Key，也不会到达 `/v1`。某分组的模型读取失败时，该行保留既有模型 ID 并标记 `catalogError`，直到单分组刷新或下一次目录读取重试。单分组刷新核验在线授权、持久化确认的分组元数据并重读该只读目录；它从不创建、核验或揭示令牌。连接弹窗保存时先为每个尚无绑定的被改动分组做准备——复用已记录的令牌或 Key 引用，或恰好创建一次该分组 Key——再将每个勾选对照该分组 Key 目录验证；保存启用旧目录未列出的模型时，会用该组 Key 重读在线目录，随后一次原子写入提交全部被改动分组的绑定与勾选。任何新增都会重读一次获准分组列表：新增分组已不在在线列表中、或在保存准备期间被后续读取确认撤销时，整体拒绝保存；保存失败保留全部已存勾选与待定令牌 ID 供复用，重试不会重复创建。每个分组拥有稳定 provider 路由——迁移的旧绑定保留 `vvcode`，其余分组由源地址、账号和分组派生 `vvcode-group-…`——因此同名模型在两个分组下解析到两个 Key，发布的模型名带一个 ` · 分组` 标签，选项编辑器会把它剥回原名。成功读取不再列出的分组标记为已撤销：Key 与勾选保留，但路由停止服务，直到后续读取重新列出。读取失败不改任何数据。账号过期保留全部行供本地取消勾选，并禁止新增、刷新与推理。旧单分组字段在下一次写入时原子迁移进 `vvcodeConnections`，在此之前照常服务。`vvcode` 配置 HTTPS 源地址和请求限制。

`vvcodeUsage` 在不调用模型的情况下读取钱包余额和有效订阅。无凭据的 `/api/status` 读取声明展示单位——USD、按站点 USD 汇率换算的 CNY、带汇率和符号的自定义货币，或原始 TOKENS——配置缺失或不可用时整个读取失败，不假设任何默认值。余额来自 `/api/user/self`，只需授权的 `profile:read` scope；订阅来自 `/api/subscription/self`，还需要只读的 `wallet:read` scope。缺少该 scope，或服务端拒绝该读取时，订阅报告为需重新授权，余额仍正常显示。余额与订阅各自独立失败，每条有效订阅单独报告、不累加总额，管理请求 401 会使账号过期，直到下次登录。

已有手动 API 提供方，包括名为 `vvcode` 的连接，仍归 `llm-pi-ai` 所有。订阅的空账号路由选择未被占用的标识。只有已保存的分组绑定使用订阅的型号选项命名空间，提供方名称前缀相同不会转移所有权。

远程请求与响应字段由 [`src/types.ts`](src/types.ts) 定义。

排查 Codex WebSocket 中断时，可在 `$DSH_HOME/logs/codex-websocket.jsonl`（Hemi 桌面默认是 `~/.hemi-dsh/logs/codex-websocket.jsonl`）中按会话 ID 搜索。SDK 首次报告 WebSocket 故障时创建该文件。每行记录路由、时间、是否已开始流式输出、可用的关闭码和 SDK 最终结果，包括是否改用 SSE。本地日志不包含提示词、令牌或原始关闭原因。文件写入失败时，宿主日志会接收脱敏后的诊断。删除文件即可清除旧记录。

推理能力依次采用显式档位、已识别模型支持的档位；没有解析出可用档位时，才采用配置的 `reasoningFallbacks`，未声明协议的路由沿用其安装目录各型号一致的协议。已知非推理模型或显式禁用的设置不会获得兜底档位。协议预置中，OpenAI Chat Completions、Responses 和 Codex Responses 默认 `medium`，Anthropic Messages 默认 `high`。请求协议负责参数编码；兼容的模型专用思考格式同时控制思考的启用和关闭。这些默认值只在运行时生效，由选择器和实际请求共用。Anthropic 的补齐型号默认使用自适应思考，显式配置仍优先。

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
- VVCode 浏览器授权要求浏览器与 Host 位于同一台电脑。其 PAT 有效期为 30 天，不支持 refresh token；授权过期或被拒绝时保留选择，但重新授权前不能推理。断开只移除本地凭据，不撤销服务端 PAT 或模型 Key。创建的模型 Key 不设独立额度和期限，仍受账号余额及分组权限限制；服务端剩余令牌须在 VVCode 管理。
- VVCode 在发送前记录令牌创建，结果不明时不会自动重发。已经返回的令牌 ID 可用于恢复。未取得 ID 时，普通精确名称查询无法恢复应用专属令牌：应用会停止创建，所有者须向 VVCode 确认服务端状态后再断开重连。只读目录可能列出某分组 Key 未通告的模型；启用这类模型会被整体拒绝，而不是静默跳过。
- 早于 `wallet:read` scope 签发的 VVCode 授权保留原 scope：余额仍可读取，但订阅显示需重新授权，直到账号重新登录并获得包含该 scope 的新授权。

### 开发备注

<a id="dev-note"></a>

无。
