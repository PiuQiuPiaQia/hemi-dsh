---
kind: upgrade-guide
description: "型号目录默认值可为空，默认型号初始化必须显式指定提供方。"
---

# 提供方中立的 Desktop 启动

[English](guide.md) | 中文

## 变更

Hemi Desktop 不依赖提供方登录或 API Key 进入工作区。首次引导提供配置模型和进入工作区两个入口；DeepSeek 登录、过期和退出不再决定应用显示哪个窗口。已有凭据和 Session 日志保留。

默认型号配置接受同时设置 `provider: null` 与 `model: null`。`currentSelection()` 可返回 `undefined`，`session/modelCatalog` 可返回 `default: null`。未选择模型时，提示词在内容准入前以 `session/model-not-selected` 拒绝。已有 Session 选型保持不变。

`session/initializeDefaultModel` 现在必须显式传入 `provider`。账号界面默认保留原有行为；Hemi Desktop 显式关闭账号拥有的首次引导和自动默认型号初始化。

## 迁移

1. 请求 DeepSeek 账号型号初始化的 Remote 调用方传入 `{ provider: 'deepseek-account' }`；同进程调用向 `initializeDefaultModel` 传入 `'deepseek-account'`。
2. 处理缺失的 `currentSelection()` 与为空的型号目录默认值。保留明确保存的选型，不替换成其他提供方。
3. 仅在明确未配置的部署中将两个默认型号字段同时设为空。仅一个字段为空会被拒绝。
4. 无提供方凭据启动 Desktop，确认工作区与模型接入设置可打开。发送消息前选择模型；退出提供方账号后工作区应保持打开。
