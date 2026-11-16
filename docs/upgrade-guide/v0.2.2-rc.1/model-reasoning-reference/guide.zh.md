---
kind: upgrade-guide
description: "目录引用提供兼容的推理档位，并拒绝相互矛盾的显式强度配置。"
---

# 推理能力遵循统一的模型声明

[English](guide.md) | 中文

## 变更

当来源与目标采用兼容的 OpenAI 强度编码时，`catalogProvider` 引用可提供推理标记及档位映射。Hemi 同时按已识别的模型解析能力，不依赖连接的提供方名称，并优先采用显式档位声明。模型支持的档位保留；没有解析出可用档位时才采用协议兜底，已知非推理模型和显式禁用不会获得兜底档位。兼容的模型专用思考格式控制启用／关闭参数，不引入原厂接口地址或鉴权。VVCode 与普通 API 连接使用相同的配置处理规则。

显式 `reasoningEfforts` 字典与生效的 `compat.supportsReasoningEffort: false` 相互矛盾。严格配置写入现在会拒绝它；延迟读取保留诊断并暂不提供该模型，而不是展示请求中不会发送的档位。部署若在原生推理模型上禁用强度参数，还必须声明 `compat.thinkingFormat`：OpenAI 格式路由撤下可控档位，声明的供应商格式保留自身思考通道。

## 迁移

1. 如果显式配置了思考档位，检查路由与模型的 `compat.supportsReasoningEffort`。仅当端点接受这些强度参数时保留字典，否则删除字典或设置 `reasoningEfforts: false`。在原生推理模型上禁用参数时，声明实际思考格式，不要将编码留为未指定。
2. 保留现有 `reasoningFallbacks` 设置。没有解析出可用模型档位时，OpenAI 和 Anthropic 的部署默认值仍可用；这些是策略，不是服务端能力探测。模型 ID 存在歧义时，通过显式 `catalogProvider` 选择所需的内置能力记录。
3. 打开模型选择器检查提供的档位。目录引用模型遵循引用条目支持的档位，VVCode 同时保留已配置的默认强度。不支持的档位会在发送模型请求前被拒绝。

模型 ID 匹配只代表目录引用，不是对网关实际后端模型的验证。[模型接入设置](../../../../packages/hemi/model-access/README.zh.md)说明覆盖值与网关默认策略。
