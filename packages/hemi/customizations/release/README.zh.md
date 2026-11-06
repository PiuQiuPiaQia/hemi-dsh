---
description: "通过 GitHub 发布 Hemi Desktop，macOS 使用固定自签名证书，Windows 使用未签名安装包。"
---

# Hemi Desktop GitHub 发布

[English](README.md) | 中文

## 概述

[GitHub 工作流](../../../../.github/workflows/hemi-desktop-release.yml)默认使用 `community`：macOS 使用 Hemi 现有的固定自签名证书，Windows 生成未签名 NSIS 安装包。两者保留 DSH 的 generic 更新器、渠道选择、任务停止确认和原生安装。Releases 保存固定版本文件；独立公开分支保存按平台区分的更新清单。`official` 选项保留 DSH 的 Developer ID／公证及 Windows EV 要求。

## 目录

- [配置社区发布](#configure-community-releases)
- [签名与安装](#signing-and-installation)
- [选择并发布版本](#select-and-publish-a-version)
- [清单与兼容性](#feeds-and-compatibility)
- [失败与恢复](#failures-and-recovery)
- [验证](#verification)

<a id="configure-community-releases"></a>

## 配置社区发布

使用包含源码提交的公开 fork。工作流发布到自身的 `github.repository`。应用不包含发布令牌。在 fork 配置以下 Actions secrets，使用原 Hemi 构建的同一份身份：

| Secret | 值 |
| --- | --- |
| `HEMI_MAC_SIGNING_P12` | 现有固定证书 p12 文件的 Base64 |
| `HEMI_MAC_SIGNING_PASSWORD` | 其导出密码；CI dotenv 编码拒绝换行、NUL 和单引号 |

源码只包含 Hemi 公钥证书。缺少 secrets、私钥不可用或证书不匹配时停止 Mac 打包；工作流不生成替代身份，也不退回 ad-hoc 签名。私有输入只写入托管 runner 自有的临时目录，打包结束后删除。临时钥匙串在子操作结束后删除，并恢复原用户搜索列表。工具不修改证书信任设置。Windows 不需要这两个 secret。

社区构建使用 GitHub 托管的 `macos-15` 运行 arm64、`macos-15-intel` 运行 x64、`windows-latest` 运行 Windows。不需要自托管 runner 配置或 Apple 公证凭据。可选仓库变量为 `HEMI_DESKTOP_APP_ID`（默认 `ai.hemi.dsh.desktop`）、`HEMI_DESKTOP_FEED_BRANCH`（默认 `desktop-update-feeds`）和 `HEMI_DESKTOP_RELEASE_TARGETS`（`mac-arm64`、`mac-all`、`win-x64` 或 `all`，默认 `mac-arm64`）。为已有 DSH fork 安装准备升级时保留其应用 ID。

为发布操作者配置 `hemi-desktop-production` GitHub Environment。它的保护设置控制发布 job。仅该 job 获得 contents 写权限。分支和 tag 规则须允许其独立清单分支及发布 tag；工具不会修改仓库权限。

本地构建可将 [production.env.example](production.env.example) 作为独立配置目录中的 `presets/production.env`。Mac 的 `secrets/macos-signing.env` 提供同一证书的 `CSC_LINK` 和 `CSC_KEY_PASSWORD`。设置 `DSH_PACKAGING_PRESET=production`，将 `DSH_PACKAGING_CONFIG_DIR` 指向该目录的绝对路径。平台 dotenv 文件接受相同的公开字段。父进程中的 Hemi 分发设置不能重定向由文件管理的打包。

选择 `official` 时沿用现有签名机器流程。选中目标需要 `HEMI_DESKTOP_MAC_CONFIG_DIR` 或 `HEMI_DESKTOP_WINDOWS_CONFIG_DIR`，可选 runner 标签为 `HEMI_DESKTOP_MAC_RUNNER` 和 `HEMI_DESKTOP_WINDOWS_RUNNER`。证书、公证和 EV 配置遵循 [Desktop 打包](../../../../apps/desktop/packaging/README.zh.md)。tag 触发的工作流可通过仓库变量 `HEMI_DESKTOP_SIGNING_MODE` 选择该模式，否则使用 `community`。

<a id="signing-and-installation"></a>

## 签名与安装

本地公开 preset 显式配置 `HEMI_DESKTOP_SIGNING_MODE=community`、GitHub 仓库、`DSH_DESKTOP_AUTO_UPDATE_ENV=production`，并可选 `HEMI_DESKTOP_UPDATE_POLICY=disabled`。省略签名模式时保留常规 DSH 要求。`stable` 和 `nightly` 更新渠道独立于签名方式。COS 上传命令会拒绝 GitHub 安装包。

Mac 打包使用固定证书签名，并校验嵌套代码、全部架构和精确 designated requirement：bundle 标识加证书指纹。同一证书会在文件清单封存前签署独立原生库和内置 Node/Python 运行时。共享的 Desktop 遍历保留分架构 JIT 权限、已验证的 Python 别名和已封存的辅助应用。自签名原生代码还声明[库校验例外](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation)，因为这些证书没有加载原生库所需的 Apple Team ID。流程不请求时间戳服务或 Apple 公证。两个架构的 Computer Use helper 使用同一证书，并校验原生回执和相同签名要求。这不会创建用于 npm 发布的官方公证 helper manifest。macOS 首次授权仍须手动完成；签名一致本身不能证明权限保留。

固定 designated requirement 让 Squirrel.Mac 能校验同一身份签出的后续构建。流程继续使用原生更新器，不安装应用换包脚本或系统信任例外。这些包没有 Apple 公证票据；首次安装／打开仍受 macOS 安全批准约束。已有 ad-hoc 或其他签名的安装，须先经过独立验收的手动安装，才能依赖该身份的更新。

Windows 社区包没有 Authenticode 发布者签名。其更新器显式省略发布者签名校验，保留 SHA-512 文件校验和 DSH 独立的安装授权。Release／清单写权限控制该分发。Windows 可能显示未知发布者提示。正式 Windows 校验保持不变。

<a id="select-and-publish-a-version"></a>

## 选择并发布版本

手动运行 **Release Hemi Desktop · GitHub**，选择完整构建版本、渠道、目标组和签名模式。也可推送 `hemi-desktop-v<version>`；普通版本号选择 `stable`，预发布版本号选择 `nightly`。版本遵循[现有构建版本规则](../../../../apps/desktop/packaging/README.zh.md#release-versions)。Stable 要求产品本身为正式版本。流程不使用依赖 COS 的自动版本发现。

所有选中目标使用相同的固定源码提交和版本。打包阶段不发布。单一发布器校验完成记录、干净源码身份、签名模式、固定 Mac 证书、更新 URL、大小和 SHA-512。它创建 `hemi-desktop-<channel>-v<version>`，生成发布说明，恢复匹配草稿，并校验 GitHub 返回的附件 SHA-256／大小。先公开 Release，再以一次非强制 Git 提交推进所有选中清单。编辑说明时保留 `Hemi Desktop package:` 标记行，以便重试识别安装包。

下载的产物可通过 `pnpm --dir apps/desktop run github:release preview --signing-mode community --artifacts <directory> --version <version> --channel <channel> --targets <targets> --repository <owner/repo> --commit <source-sha>` 写入本地 `release-plan.json`，不访问网络。目录中每个目标各有一个子目录。`publish` 接受相同选择并要求 `GH_TOKEN`；Actions 仅在发布时提供受限令牌。常规 DSH 签名记录使用 `--signing-mode official`。发布器拒绝混合模式和变更的 Mac 证书指纹。

<a id="feeds-and-compatibility"></a>

## 清单与兼容性

包内 URL 为 `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/feeds/<target>/`。Windows 使用 `stable.yml` / `nightly.yml`；macOS 使用 `stable-mac.yml` / `nightly-mac.yml`。各文件包含固定版本的 Release 绝对 URL 和 SHA-512。独立的架构目录允许单平台发布，不覆盖其他目标或渠道。

客户端读取清单不需要令牌或 REST 轮询。Release 的预发布标记不决定客户端渠道。DSH 的仅升级到更高版本规则、下载批准、任务停止检查和安装确认继续生效。渠道在首次发布后可用。更改仓库、分支、应用 ID 或证书需要兼容性验收；原 Hemi 数据迁移不属于本流程。

Raw GitHub 缓存可能延迟可见性。发布操作者须在支持的用户网络中验收清单和文件访问；API 确认分支提交不代表公开 CDN 已可用。

<a id="failures-and-recovery"></a>

## 失败与恢复

产物仍在保留期时，在同一工作流运行中重跑失败 job。成功目标产物会复用；其记录须匹配源码、版本、地址和签名模式。重新构建已公开版本可能产生不同字节，冲突时会被拒绝。

HTTP 操作有截止时间，不自动重试。上传失败或结果不明时不修改清单；重跑按 SHA-256 核对匹配的远端附件。已公开附件不会删除或替换。清单写入失败可能留下尚未交付客户端的公开 Release；重跑完成清单推进。写入结果不明时读取分支核对。清单版本更高、同版本内容冲突、无效清单、证书变更或源码 tag 不匹配均停止发布。并发分支移动使非强制更新失败，不会丢弃其他清单。

冲突后先检查再重试，包内容变化时使用更高版本。不要轮换固定证书、替换公开附件、移动源码 tag 或强推清单来使重试通过。Actions 保留安装包 14 天、发布计划 30 天；已公开安装包继续作为 Release 附件存在。

<a id="verification"></a>

## 验证

单元测试覆盖两种签名模式、自有凭据清理、拒绝路径、包哈希、真实更新器解析和发布恢复。运行 `pnpm exec vitest run apps/desktop/tests/hemi-community-signing.spec.ts apps/desktop/tests/hemi-github-update.spec.ts packages/hemi/customizations/tests/github-release.spec.ts`。

macOS 安装 Node 24 和工作区依赖后，`python3 apps/desktop/tests/fixtures/hemi-community-signing.py --native` 只创建临时证书、钥匙串和 Electron 应用，通过产品签名器签署不同构建，再检查真实 Squirrel.Mac 是否接受更新。它不读取保存的 Hemi 私钥、不添加证书信任，也不更新已安装应用。运行期间不要并发修改钥匙串搜索列表。

隔离验证证明证书连续性和原生更新准备。发布操作者仍须验收真实托管 runner 构建、GitHub 权限、首次打开安全行为、最终安装／重启、用户数据保留及真实 Computer Use 权限连续性。本地测试不创建生产 Release。
