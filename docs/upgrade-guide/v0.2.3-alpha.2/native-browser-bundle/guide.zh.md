---
kind: upgrade-guide
description: "Hemi Desktop 使用随版本预装的 dsh-native-browser，不再加载另行安装的副本。"
---

# Hemi Desktop 预装 `dsh-native-browser`

[English](guide.md) | 中文

## 变更

Hemi Desktop 以前从 Desktop profile 载入浏览器插件。现在，启用该插件时，即使 profile 中安装了不同版本，Hemi Desktop 也会使用随版本提供的副本。升级保留 profile 文件、浏览器配置以及已有的启停选择。

## 迁移

1. 在 Hemi Desktop 的「插件」页检查 `dsh-native-browser` 的开关状态。要停用浏览器控制，请关闭该插件的开关，无需卸载。
2. 在 macOS 上，如果原有的 Chrome 连接失效，请在已安装的 Hemi Desktop 侧栏打开「浏览器」。按提示同步组件、重新加载 Chrome 扩展并检查连接。确认状态显示「Chrome 已连接」。
