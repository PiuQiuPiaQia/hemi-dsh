/** Typed copy for phone connection management; internal Host diagnostics never reach this dictionary. */

/** Copy keys shared by both supported languages. */
export type MobileLocaleKey =
  | 'nav' | 'description' | 'off' | 'on' | 'start' | 'stop' | 'noNetwork'
  | 'pairTitle' | 'pairHelp' | 'generate' | 'regenerate' | 'expired' | 'remaining' | 'copy' | 'copied' | 'manual' | 'manualHelp'
  | 'invitationMissing' | 'qrAlt' | 'qrFailed' | 'confirmTitle' | 'code' | 'risk' | 'approve' | 'reject'
  | 'devices' | 'connected' | 'paired' | 'revoke'
  | 'retry' | 'loading' | 'busy' | 'localOnly' | 'readFailed' | 'failed' | 'unknown' | 'invitationFailed'
  | 'notListening' | 'requestGone' | 'wrongCode' | 'deviceGone' | 'credentialsFailed' | 'listenFailed' | 'copyFailed'
  | 'stopped' | 'revoked' | 'denied'
  | 'computer' | 'disconnect' | 'disconnectUnknown'

/** English settings labels. */
export const en: Record<MobileLocaleKey, string> = {
  computer: 'Connected computer', disconnect: 'Disconnect',
  disconnectUnknown: 'Could not confirm disconnection. Close Hemi and reopen it to check.',
  nav: 'Phone connection',
  description: 'Connect your iPhone to this computer on the same Wi-Fi.',
  off: 'Off', on: 'On', start: 'Enable phone connection', stop: 'Turn off phone connection',
  noNetwork: 'Wi-Fi is unavailable. Connect this computer to Wi-Fi, then retry.',
  pairTitle: 'Pair a phone', pairHelp: 'Scan with Hemi on your iPhone.',
  generate: 'Generate invitation', regenerate: 'Generate a new invitation', expired: 'Invitation expired',
  remaining: 'Expires in {seconds}s', copy: 'Copy pairing content', copied: 'Pairing content copied', manual: 'Pair manually',
  manualHelp: 'Paste this content into the phone’s pairing screen. Share it only with your own phone.',
  invitationMissing: 'Generate a new invitation to show its QR code on this page.', qrAlt: 'Single-use phone pairing QR code',
  qrFailed: 'The QR code could not be created. Copy the pairing content instead.',
  confirmTitle: 'Confirm {device}', code: 'Verification code',
  risk: 'Compare the code on your phone. Allow only a trusted phone: it can view conversations, run tasks, and access files.',
  approve: 'Codes match, allow connection', reject: 'Reject',
  devices: 'Paired devices', connected: 'Connected', paired: 'Paired',
  revoke: 'Revoke access', retry: 'Retry', loading: 'Loading phone connection', busy: 'Working…',
  localOnly: 'Manage phone connections on this computer.',
  readFailed: 'Could not refresh phone connections. Retry before making changes.',
  failed: 'The action failed. Refresh the list, then try again.',
  unknown: 'The result could not be confirmed. Refresh and check the connection or device before trying again.',
  invitationFailed: 'Phone connection is on, but its invitation could not be created. Generate a new invitation.',
  notListening: 'Phone connection is off. Refresh, then enable it to pair a phone.',
  requestGone: 'This request is no longer available. Ask the phone to pair again.',
  wrongCode: 'The verification code changed. Refresh and compare both devices again.',
  deviceGone: 'This device is no longer paired. Refresh the list.',
  credentialsFailed: 'Paired devices could not be saved or read. Check this computer’s credential storage, then retry.',
  listenFailed: 'Phone connection could not start. Check your Wi-Fi connection, then retry.',
  copyFailed: 'Could not copy. Open “Pair manually” and copy its content.',
  stopped: 'Phone connection is off. Paired devices and running tasks are unchanged.',
  revoked: 'Device access revoked', denied: 'Connection request rejected',
}

/** Chinese settings labels. */
export const zh: Record<MobileLocaleKey, string> = {
  computer: '连接的电脑', disconnect: '断开连接',
  disconnectUnknown: '无法确认是否已断开，请关闭 Hemi 后重新打开检查',
  nav: '手机连接',
  description: '让同一 Wi-Fi 下的 iPhone 连接这台电脑',
  off: '未开启', on: '已开启', start: '开启手机连接', stop: '关闭手机连接',
  noNetwork: 'Wi-Fi 不可用，请让此电脑连接 Wi-Fi 后重试',
  pairTitle: '配对手机', pairHelp: '使用 iPhone 上的 Hemi 扫码',
  generate: '生成配对邀请', regenerate: '重新生成邀请', expired: '配对邀请已过期',
  remaining: '{seconds} 秒后过期', copy: '复制配对内容', copied: '已复制配对内容', manual: '手动配对',
  manualHelp: '将以下内容粘贴到手机的配对页面，仅与你自己的手机分享',
  invitationMissing: '重新生成邀请，即可在此页显示二维码', qrAlt: '一次性手机配对二维码',
  qrFailed: '二维码生成失败，可复制配对内容继续配对',
  confirmTitle: '确认连接 {device}', code: '核对码',
  risk: '请核对手机上的号码。仅允许可信手机：它可查看会话、执行任务和访问文件',
  approve: '号码一致，允许连接', reject: '拒绝',
  devices: '已配对设备', connected: '已连接', paired: '已配对',
  revoke: '撤销访问', retry: '重试', loading: '正在读取手机连接', busy: '处理中…',
  localOnly: '请在电脑端管理手机连接',
  readFailed: '无法刷新手机连接，请重试后再操作',
  failed: '操作失败，请刷新列表后重试',
  unknown: '无法确认操作结果，请刷新并检查连接或设备状态后再重试',
  invitationFailed: '手机连接已开启，但邀请生成失败，请重新生成邀请',
  notListening: '手机连接未开启，请刷新并开启后再配对',
  requestGone: '此请求已失效，请让手机重新发起配对',
  wrongCode: '核对码已变化，请刷新后重新核对两台设备',
  deviceGone: '此设备已不在配对列表中，请刷新列表',
  credentialsFailed: '无法读取或保存配对设备，请检查此电脑的凭据存储后重试',
  listenFailed: '无法开启手机连接，请检查 Wi-Fi 连接后重试',
  copyFailed: '复制失败，请展开「手动配对」后复制内容',
  stopped: '手机连接已关闭，已配对设备和运行中的任务保持不变',
  revoked: '已撤销设备访问', denied: '已拒绝连接请求',
}
