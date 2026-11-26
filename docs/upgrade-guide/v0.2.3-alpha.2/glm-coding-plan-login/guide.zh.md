---
kind: upgrade-guide
description: "Hemi 的 GLM Coding Plan 新授权需要使用已关联套餐所属 BigModel 账号的 Z.ai 中国区账号。"
---

# GLM Coding Plan 浏览器登录

[English](guide.md) | 中文

## 变更

Hemi 在 GLM Coding Plan 新授权时打开 Z.ai 中国区登录页，不再直接打开 BigModel 登录页。新登录需要已关联的 BigModel 账号。已有的有效授权和型号选择保持不变。

## 迁移

1. 如果 GLM Coding Plan 已连接且可以正常使用，保留现有连接。
2. 需要登录时，在 **模型接入 → GLM Coding Plan** 中发起授权。在浏览器中使用已关联到套餐所属 BigModel 账号的 Z.ai 中国区账号。
3. 返回 Hemi，确认 GLM Coding Plan 显示为已连接。如果账号尚未关联，请先到提供方完成关联，再重新授权。
