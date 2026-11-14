---
description: "让同一家庭局域网内已配对的 iPhone 通过 TLS 使用这台 Hemi 桌面宿主。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hemi-mobile-access

[English](README.md) | 中文

## 概述

让同一家庭网络内已配对的手机使用这台桌面的 Hemi 宿主。开启后自动绑定可用的私网 IPv4 地址，用户无需选择地址。一次性邀请携带连接候选与固定证书，所有者核对六位验证码后批准。已批准的手机以独立 owner Peer 使用现有 `/api` 桥与 Remote 复用通道。撤销会关闭其连接，不停止宿主已经接受的智能体任务。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

Hemi Desktop 将本服务与移动访问设置界面组合。所有者开启前不监听网络。`start` 不接收网络地址：宿主枚举候选并使用同一个端口绑定。最近的主地址与端口持久保存；后续启动重新枚举地址并复用端口。端口冲突会显式失败，不会静默迁移服务。

绑定地址来自宿主当前网卡：仅限私网（RFC1918）或链路本地范围内的具体非内部 IPv4 地址。公网与通配地址被拒绝。证书在进程内生成（IP SAN、`serverAuth`、SHA-256）并跨重启复用；邀请携带其 SHA-256 指纹，手机端固定该指纹。

配对一次一张邀请：120 秒一次性令牌经二维码或复制传递，一部手机认领，所有者在确认对话框中核对双端显示的验证码。设备密钥只存在于手机与 DSH 凭据库的哈希中；管理状态永不返回令牌或哈希。

### Configuration

| 字段 | 默认值 | 含义 |
|---|---|---|
| `port` | `0` | 监听端口。`0` 先由系统分配一次，之后持久化并复用；显式端口恒优先。 |
| `serverName` | 机器主机名 | 配对与会话响应中展示给手机的名字。 |
| `invitationTtlSeconds` | `120` | 一次性邀请有效期。 |
| `requestTtlSeconds` | `300` | 待定配对认领有效期。 |
| `maxPairBodyBytes` | `8192` | 配对端点 JSON 请求体上限。 |
| `pairRequestsPerMinute` | `20` | 每个远端地址每分钟的配对端点事件数。 |
| `maxDevices` | `10` | 已批准设备目录上限。 |
| `maxApiBodyBytes` | `67108864` | 转发给共享桥的 `/api` 缓冲请求体上限。 |

<a id="understand-the-implementation"></a>
## 理解实现

本服务拥有单一生命周期事务：启动、停止与卸载在同一条链上串行。每个具体地址的监听属于一个连接组代次，绑定与端口持久化提交前均返回 503。停止同步撤回准入，并等待所有资源收敛。手机流量进入该组的监听成员，先经过 Host/Origin/跨站栅栏与公共配对端点限流，再以常时密钥哈希比对完成设备认证，然后把获准流量转发到现有缝隙——`/api` 走 Connection 桥及其共享准入瀑布，其余 GET/HEAD 以设备自身 Peer 读取 webServer 已注册资源，唯一的 `/api/remote.mux` WebSocket 升级走网关复用器。凭据库变更使代际栅栏缓存失效并重读存储，同时退役设备记录消失或密钥哈希轮换的在线 Peer。

<details>
<summary>配对与设备记录</summary>

一次配对批准会预留其请求行，先持久写入设备记录（id、名称、创建时间、密钥哈希），然后才发布 `approved`；失败或竞争的写入释放请求行并撤回记录。TLS 材料、设备目录与最近监听事实各存为本插件作用域下的一条凭据 grant 记录，并按严格模式校验，损坏的记录会显式失败，而不是读作不存在或为空。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Connection HTTP bridge](../../client/connection/README.zh.md) — 每个手机请求都经过的共享 `/api` 准入与请求瀑布。
- [Typert Gateway](../../api/gateway/README.zh.md) — 手机 WebSocket 加入的 Remote 复用器。
- [Credential seam](../../credentials/credentials/README.zh.md) — 保存设备目录、TLS 材料与监听事实的 grant 记录。

<a id="model-experience"></a>
## 模型体验

### 手机驱动的会话

#### 模型所见

不新增提示词段落、工具 schema 或 Session 事件。已配对手机的请求经现有 `/api` 桥以普通 owner Peer 调用到达，模型所见与任何 owner 客户端产生的会话流量完全一致。

#### Token 影响

除请求本身外为零：配对、TLS 监听与设备目录永不进入提示词。

#### KV 缓存影响

本包不触碰请求前缀。手机驱动的 Session 与桌面客户端驱动同一 Session 时按相同条件复用提供商缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 邀请可附加最多 32 个同端口的 `origins`，主地址在前。手机无凭据探测后选择一个可达且固定证书的地址，再单次提交配对请求。网卡变化需关闭再开启连接；证书改变仍需新邀请。不使用 mDNS、云中转或静默证书信任。
- 同一时间只有一张邀请；待定认领无法从宿主取消——手机停止轮询，认领按 TTL 过期。
- 已批准的手机具有完整的 owner 任务与文件权限。桌面专用管理 RPC 不是针对 owner 可指示智能体执行的操作的沙箱；请仅批准可信设备。
- 本包内的 Loader 级组合测试仅覆盖宿主侧；完整的浏览器驱动配对在桌面应用自身的测试通道运行。
- 配对请求按设计只存在于内存；宿主重启清空它们，已批准设备持久保留。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
