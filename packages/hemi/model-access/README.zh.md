---
description: "订阅授权、额度查询和 New API 模型导入的宿主操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-model-access

[English](README.md) | 中文

## 概述

Profile 所有者可以通过 Harness OAuth 连接 ChatGPT Codex、Claude 和 GitHub Copilot，也可以通过迁移自 Hemi 的授权流程连接 GLM Coding Plan。ChatGPT Codex 和 GLM Coding Plan 提供额度查询。桌面端的 New API 导入使用独立登录窗核验站点账号，按分组读取模型，再按用户确认的计划创建令牌。用户也可以手动导入已有令牌。

## 目录

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

模型能力编辑使用打开编辑器时读取的设置版本，保留无关模型字段。API 和目录订阅模型的覆盖值保存在 `llm-pi-ai` 中；Hemi 自有 GLM 适配器从本插件设置的 `subscriptionModelOptions.bigmodel` 读取覆盖值。移除可选字段可恢复适配器默认值。改动影响后续模型解析，已经准备的请求保留原模型配置。

订阅型号在每次打开或刷新时重新请求服务端，查询失败不会用内置目录替代。Codex 使用登录账号的 `/backend-api/codex/models` 接口，Claude 和 Copilot 请求各自的鉴权型号接口。GLM 通过 `/api/v1/client/configs` 和公共 CDN 读取官方在线 ZCode Coding Plan 目录；这是公布的个人／团队套餐目录，不是逐账号权益校验。公共目录请求不携带账号凭据。响应不兼容或服务不可用时保留已有型号选择。`subscriptionDiscovery` 可配置请求时限、目录数量上限和外部 Codex／ZCode 客户端版本。

远程请求与响应字段由 [`src/types.ts`](src/types.ts) 定义。

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
