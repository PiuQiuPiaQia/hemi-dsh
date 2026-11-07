// 047 导入协调器：状态机、控制权、journal 边界、原子提交与恢复。
//
// 铁律（technical-plan §4/§5）：
// - 「创建 Key 并导入」是唯一远端写入起点；一次 operation 最多授权一次创建派发
//   （journal 先落 may-have-been-sent 再发请求；崩溃后保守恢复，不重建）。
// - 完整 Key 只进主进程内存与加密 journal；不进 DOM/renderer/日志/DTO。
// - 恢复先读目录回执（提交事实权威），再读 journal；回执在＝已导入，不撤销。
// - 取消只撤销本次已核验归属的精确 id；撤销失败保留 cleanup-pending，不假报清理。
// - 站点页面驱动策略：自动化经同会话面板 API（创建/读 Key/撤销），页面保留
//   给用户登录与查看；创建请求体与站点原表单一致（newapi-adapter）。
import { createHash } from 'node:crypto';
import path from 'node:path';

import { createImportJournal } from './journal.mjs';
import { createImportBrowser } from './import-browser.mjs';
import { createLoginStore } from './login-store.mjs';
import { createNewApiAdapter } from './newapi-adapter.mjs';
import { createAuthWitness } from './session-client.mjs';
import { normalizeSiteUrl } from './import-url.mjs';
import {
  fetchOpenaiModels,
  probeAnthropicMessages,
  probeOpenaiChat,
} from './probe.mjs';

export const IMPORT_PHASES = [
  'opening', 'login', 'discovering', 'selecting',
  'preflight', 'creating', 'reconciling', 'reading-key',
  'validating', 'ready-to-save', 'saving', 'success',
  'cancelling', 'cleanup-pending', 'cancelled', 'failed',
];

const AUTOMATION_PHASES = new Set(['preflight', 'creating', 'reconciling', 'reading-key', 'validating', 'ready-to-save', 'saving', 'cancelling']);

const ERROR_MESSAGES = {
  BAD_URL: '站点地址不可用',
  OPEN_SITE: '无法打开站点登录页面。请取消本次接入，检查地址和网络后重试',
  UNSUPPORTED: '这个站点不像受支持的 New API 部署',
  LOGIN_REQUIRED: '站点要求重新登录',
  ACCOUNT_CHANGED: '登录的账号和这次导入不一致',
  NO_GROUPS: '这个账号没有可用的分组',
  ENCRYPTION_UNAVAILABLE: '本机暂时无法加密保存（本机存储不可用）',
  ENV_OVERRIDE: '环境变量（HEMI_LLM_*）正在覆盖模型配置，先清掉再导入',
  STORE_CORRUPT: '模型配置目录损坏，修复后才能导入',
  STORE_FAILED: '本机保存失败，Key 已创建，稍后重试保存',
  STORE_CONFLICT: '导入计划与已保存的配置冲突',
  CREATE_REJECTED: '站点拒绝创建令牌',
  RECONCILE_PENDING: '创建结果还没核对清楚，稍后再查',
  TOKEN_AMBIGUOUS: '站点上有多条同名令牌，没法确认哪条是这次的',
  KEY_INVALID: '站点返回的 Key 格式不对',
  VERIFY_FAILED: '有型号没通过验证',
  CLEANUP_PENDING: '没能撤销这次创建的 Key，需要手动处理',
  PAUSED: '已暂停',
  API_ERROR: '站点返回了错误',
  INTERNAL: '导入过程出错',
};

const PHASE_PROGRESS = {
  preflight: '创建前检查',
  creating: '正在创建 Key',
  reconciling: '正在核对令牌',
  'reading-key': '正在读取 Key',
  validating: '正在验证模型',
  'ready-to-save': '准备保存',
  saving: '正在保存配置',
  cancelling: '正在撤销这次创建的 Key',
};

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function newOperationId(nowFn = Date.now) {
  return `pi-${nowFn().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function tokenNameFor(nowFn = Date.now) {
  const date = new Date(nowFn());
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `Hemi-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

class PausedSignal extends Error {
  constructor() {
    super('paused');
    this.code = 'PAUSED';
  }
}

function withTimeout(promise, ms, code = 'NETWORK') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('请求超时'), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {{ getMainWindow: Function, createView: Function, sessionFromPartition: any, safeStorage: any, getProfilesStore: Function, journalDirPath: string, env?: object, now?: Function, log: {info: Function, warn: Function}, fetchImpl?: Function, journalFs?: object }} deps
 */
export function createImportCoordinator({
  getMainWindow,
  createView,
  sessionFromPartition,
  safeStorage,
  getProfilesStore,
  journalDirPath,
  env = process.env,
  now = Date.now,
  log,
  fetchImpl,
  journalFs = {},
}) {
  const journal = createImportJournal({ dirPath: journalDirPath, safeStorage, log, ...journalFs });
  const loginStore = createLoginStore({ dirPath: path.join(path.dirname(journalDirPath), 'provider-logins'), safeStorage, fs: journalFs });
  /** 活动操作（同一时刻最多一个带浏览器的导入）。 */
  let active = null;
  const browserCleanups = new Set();
  let ownerSender = null; // (dto) => void，由 IPC 层注入

  function publish(op) {
    if (op.phase !== 'login') op.browser?.hide();
    op.revision += 1;
    try {
      ownerSender?.(publicState(op));
    } catch {
      /* 窗口可能已销毁 */
    }
  }

  /** 非状态机转移的界面态更新（首屏加载指示）：不动 revision，不打断进行中的命令。 */
  function publishQuiet(op) {
    try {
      ownerSender?.(publicState(op));
    } catch {
      /* 窗口可能已销毁 */
    }
  }

  /** 首屏加载完成回调：清加载态并静默推送（View 放出在 import-browser 内部完成）。 */
  function contentReadyCallback(op) {
    return () => {
      if (active !== op || op.siteLoading !== true) return;
      op.siteLoading = false;
      publishQuiet(op);
    };
  }

  function canEncrypt() {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  }

  function failOp(op, code, { retryTarget = null } = {}) {
    op.error = {
      code,
      message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL,
      ...(retryTarget ? { retryTarget } : {}),
    };
    op.phase = 'failed';
    op.control = 'user';
    op.siteLoading = false;
    publish(op);
    log?.warn?.(`导入 ${op.operationId} 失败于 ${op.lastStep ?? '-'}：${code}`);
  }

  function assertNotPaused(op) {
    if (op.abortRequested && op.control !== 'hemi') throw new PausedSignal();
    if (op.abortRequested) throw new PausedSignal();
  }

  async function journalPersist(op, extra = {}) {
    const payload = {
      siteOrigin: op.siteOrigin,
      ...(op.destination ? { destination: op.destination } : {}),
      apiBaseUrl: op.apiBaseUrl,
      accountLabel: op.accountLabel,
      userId: op.userId,
      phase: op.phase,
      cancelRequested: op.cancelRequested === true,
      intent: op.intent,
      planHash: op.planHash,
      createDispatch: op.createDispatch,
      createStartedAt: op.createStartedAt,
      tokenId: op.tokenId,
      remoteState: op.remoteState,
      apiKey: op.apiKey ?? null,
      validation: op.validation ?? null,
      committed: op.result != null,
      updatedAt: now(),
      ...extra,
    };
    await journal.persist(op.operationId, payload);
    op.journaled = true;
  }

  /** 目录协议端点：openai → {origin}/v1；anthropic → {origin}（046 两套拼接口径）。 */
  function providerBaseUrlFor(api, apiBaseUrl) {
    const base = String(apiBaseUrl ?? '').replace(/\/+$/, '');
    return api === 'anthropic-messages' ? base : `${base}/v1`;
  }

  async function loadModelCandidates(op, group) {
    if (op.candidatesGroup === group) return;
    op.candidates = await withTimeout(op.adapter.readModelCandidates(group), 15000);
    op.candidatesGroup = group;
  }

  function buildPreview(op, selection) {
    const byApi = new Map();
    for (const model of selection.models) {
      if (!byApi.has(model.api)) byApi.set(model.api, []);
      byApi.get(model.api).push(model.modelName);
    }
    const siteLabel = op.siteLabel || new URL(op.siteOrigin).hostname;
    const apis = [...byApi.keys()].sort();
    const providers = apis.map((api, index) => {
      const models = [...new Set(byApi.get(api))].sort();
      const suffix = apis.length > 1 ? (api === 'anthropic-messages' ? ' · Anthropic' : ' · OpenAI') : '';
      const name = `${siteLabel} · ${selection.group}${suffix}`.slice(0, 40);
      return {
        deterministicId: `mpi-${sha256(op.operationId).slice(0, 10)}-${index}`,
        name,
        api,
        baseUrl: providerBaseUrlFor(api, op.apiBaseUrl),
        models,
      };
    });
    const plan = {
      ...(op.destination ? { destination: op.destination } : {}),
      siteOrigin: op.siteOrigin,
      apiBaseUrl: op.apiBaseUrl,
      group: selection.group,
      budgetMode: selection.budgetMode,
      budgetUsd: selection.budgetMode === 'usd' ? selection.budgetUsd : null,
      expiryMode: selection.expiryMode,
      expiryDays: selection.expiryMode === 'days' ? selection.expiryDays : null,
      firstDefaultModelKey: selection.firstDefaultModelKey ?? null,
      providers: providers.map(({ name, api, baseUrl, models }) => ({ name, api, baseUrl, models })),
    };
    const planHash = sha256(JSON.stringify(plan));
    return { planHash, providers, plan };
  }

  async function continuePipeline(op) {
    op.running = (async () => {
      try {
        for (;;) {
          if (op.control === 'paused') return;
          switch (op.phase) {
            case 'preflight': await stepPreflight(op); break;
            case 'creating': await stepCreating(op); break;
            case 'reconciling': await stepReconcile(op); break;
            case 'reading-key': await stepReadKey(op); break;
            case 'validating': await stepValidate(op); break;
            case 'ready-to-save':
              op.phase = 'saving';
              publish(op);
              break;
            case 'saving': await stepSave(op); break;
            case 'cancelling': await stepCancelRevoke(op); break;
            default: return;
          }
        }
      } catch (error) {
        if (error instanceof PausedSignal || error?.code === 'PAUSED') {
          op.control = 'paused';
          publish(op);
          return;
        }
        if (error?.code === 'LOGIN_REQUIRED') {
          // 自动化中途登录失效：交还页面，等用户重登同一账号后从断点继续。
          // creating 中断的恢复点必须是查证——派发可能已被服务端受理，绝不重发。
          const resumeAt = op.phase === 'creating' ? 'reconciling' : op.phase;
          op.error = { code: 'LOGIN_REQUIRED', message: ERROR_MESSAGES.LOGIN_REQUIRED, retryTarget: resumeAt };
          op.control = 'user';
          op.phase = 'login';
          publish(op);
          return;
        }
        if (error?.code === 'STALE') return;
        // 中途网络/站点抖动按阶段给断点（Key 已持有时重试不重建）。
        const stageRetry = ['reconciling', 'reading-key', 'validating', 'saving'].includes(op.lastStep)
          ? op.lastStep
          : null;
        failOp(op, error?.code && ERROR_MESSAGES[error.code] ? error.code : 'INTERNAL', {
          retryTarget: error?.retryTarget ?? stageRetry,
        });
      } finally {
        op.running = null;
      }
    })();
    return op.running;
  }

  async function stepPreflight(op) {
    op.lastStep = 'preflight';
    assertNotPaused(op);
    await ensurePanel(op);
    if (!canEncrypt()) return failOp(op, 'ENCRYPTION_UNAVAILABLE', { retryTarget: 'preflight' });
    const store = getProfilesStore(op.destination);
    let directory;
    try {
      directory = await store.list();
    } catch (error) {
      return failOp(op, 'STORE_FAILED', { retryTarget: 'preflight' });
    }
    if (directory?.corrupt) return failOp(op, 'STORE_CORRUPT', { retryTarget: 'preflight' });
    if (directory?.envOverride) return failOp(op, 'ENV_OVERRIDE', { retryTarget: 'preflight' });

    // 唯一令牌名：先确认站点上没有同名（重生成直到干净）。
    let name = tokenNameFor(now);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assertNotPaused(op);
      const taken = await withTimeout(op.adapter.reconcileCreatedToken({
        tokenName: name, group: null, userId: op.userId, createdAfterMs: null,
      }), 15000).catch(() => null);
      if (taken?.status === 'absent-proven') break;
      name = tokenNameFor(now);
    }
    op.tokenName = name;
    op.intent = {
      tokenName: name,
      group: op.selection.group,
      budgetMode: op.selection.budgetMode,
      budgetUsd: op.selection.budgetMode === 'usd' ? op.selection.budgetUsd : null,
      expiryMode: op.selection.expiryMode,
      expiryDays: op.selection.expiryMode === 'days' ? op.selection.expiryDays : null,
      models: op.selection.models.map((model) => ({ modelName: model.modelName, api: model.api })),
      firstDefaultModelKey: op.selection.firstDefaultModelKey ?? null,
    };
    op.createDispatch = 'not-sent';
    await journalPersist(op);
    op.phase = 'creating';
    publish(op);
  }

  async function stepCreating(op) {
    op.lastStep = 'creating';
    assertNotPaused(op);
    // 已派发过（含断点恢复/暂停续跑）：不重发创建，直接查证。
    if (op.createDispatch !== 'not-sent') {
      op.phase = 'reconciling';
      publish(op);
      return;
    }
    // 派发前先落 may-have-been-sent：崩溃后保守恢复，不重建。
    op.createDispatch = 'may-have-been-sent';
    op.createStartedAt = now();
    await journalPersist(op);
    try {
      await withTimeout(op.adapter.createToken(op.intent), 20000);
      op.createDispatch = 'acknowledged';
    } catch (error) {
      if (error?.code === 'CREATE_REJECTED') {
        return failOp(op, 'CREATE_REJECTED', { retryTarget: 'preflight' });
      }
      if (error?.code === 'LOGIN_REQUIRED' || error?.code === 'STALE') throw error;
      // 网络/超时：结果不明，交给查证；绝不重发创建。
      log?.warn?.(`导入 ${op.operationId} 创建请求结果不明（${error?.message ?? error}），转查证`);
    }
    await journalPersist(op);
    op.phase = 'reconciling';
    publish(op);
  }

  async function stepReconcile(op) {
    op.lastStep = 'reconciling';
    if (op.tokenId != null) {
      op.phase = 'reading-key';
      publish(op);
      return;
    }
    assertNotPaused(op);
    const result = await withTimeout(op.adapter.reconcileCreatedToken({
      tokenName: op.intent.tokenName,
      group: op.intent.group,
      userId: op.userId,
      createdAfterMs: op.createStartedAt ?? null,
    }), 20000);
    if (result.status === 'one-owned-token') {
      op.tokenId = result.token.id;
      op.remoteState = 'created';
      await journalPersist(op);
      op.phase = 'reading-key';
      publish(op);
      return;
    }
    if (result.status === 'ambiguous') {
      op.remoteState = 'unknown';
      await journalPersist(op);
      return failOp(op, 'TOKEN_AMBIGUOUS', {});
    }
    // absent-proven / unknown：不证明不存在，停在可重试的查证状态。
    return failOp(op, 'RECONCILE_PENDING', { retryTarget: 'reconciling' });
  }

  async function stepReadKey(op) {
    op.lastStep = 'reading-key';
    if (op.apiKey) {
      op.phase = 'validating';
      publish(op);
      return;
    }
    assertNotPaused(op);
    const key = await withTimeout(op.adapter.readCreatedKey(op.tokenId), 20000);
    op.apiKey = key;
    await journalPersist(op); // 立即加密落盘
    op.phase = 'validating';
    publish(op);
  }

  async function stepValidate(op) {
    op.lastStep = 'validating';
    const selectionModels = op.intent.models;
    const fingerprint = sha256(JSON.stringify({
      tokenId: op.tokenId,
      group: op.intent.group,
      apiBaseUrl: op.apiBaseUrl,
      models: selectionModels,
    }));
    if (op.validation?.fingerprint === fingerprint && op.validation.results.every((item) => item.ok)) {
      op.phase = 'ready-to-save';
      publish(op);
      return;
    }
    const results = [];
    let visible = null;
    try {
      const listed = await withTimeout(fetchOpenaiModels({
        baseUrl: providerBaseUrlFor('openai-completions', op.apiBaseUrl),
        apiKey: op.apiKey,
        ...(fetchImpl ? { fetchImpl } : {}),
      }), 20000);
      if (listed.ok) visible = new Set(listed.models.map((model) => model.id));
    } catch {
      /* 模型列表拿不到时退回仅探活判定 */
    }
    for (const model of selectionModels) {
      assertNotPaused(op);
      const entry = { modelName: model.modelName, api: model.api, ok: false, code: null };
      if (visible && !visible.has(model.modelName)) {
        entry.code = 'not-visible';
        results.push(entry);
        op.validation = { fingerprint, results: [...results] };
        publish(op);
        continue;
      }
      const probe = model.api === 'anthropic-messages'
        ? probeAnthropicMessages({
          baseUrl: providerBaseUrlFor('anthropic-messages', op.apiBaseUrl),
          apiKey: op.apiKey,
          model: model.modelName,
          ...(fetchImpl ? { fetchImpl } : {}),
        })
        : probeOpenaiChat({
          baseUrl: providerBaseUrlFor('openai-completions', op.apiBaseUrl),
          apiKey: op.apiKey,
          model: model.modelName,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
      const outcome = await withTimeout(probe, 25000).catch((error) => ({ ok: false, code: error?.code ?? 'network' }));
      entry.ok = outcome.ok === true;
      entry.code = outcome.ok ? null : outcome.code ?? 'network';
      results.push(entry);
      op.validation = { fingerprint, results: [...results] };
      publish(op);
    }
    await journalPersist(op);
    if (results.some((item) => !item.ok)) {
      return failOp(op, 'VERIFY_FAILED', { retryTarget: 'validating' });
    }
    op.phase = 'ready-to-save';
    publish(op);
  }

  async function stepSave(op) {
    op.lastStep = 'saving';
    assertNotPaused(op);
    const providers = op.preview.providers.map((provider) => ({
      deterministicId: provider.deterministicId,
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api,
      models: provider.models.map((modelName) => ({ model: modelName })),
      apiKey: op.apiKey,
    }));
    let committed;
    try {
      committed = await getProfilesStore(op.destination).importProvidersAtomic({
        operationId: op.operationId,
        planHash: op.planHash,
        providers,
      });
    } catch (error) {
      return failOp(op, 'STORE_FAILED', { retryTarget: 'saving' });
    }
    op.result = {
      providerIds: committed.receipt.providerIds,
      modelKeys: committed.receipt.modelKeys,
      providers: committed.providers.map((view) => ({
        id: view.id, name: view.name, api: view.api, baseUrl: view.baseUrl, modelCount: view.models.length,
      })),
      encrypted: true,
    };
    await journalPersist(op); // committed=true（回执已是权威；这一步崩溃由回执结算）
    op.phase = 'success';
    op.control = 'user';
    publish(op);
    // 成功：清恢复秘密、回收浏览器会话（Key 已加密进目录）。
    op.apiKey = null;
    try {
      await journal.remove(op.operationId);
    } catch (error) {
      log?.warn?.(`导入 ${op.operationId} 成功但 journal 清理失败（${error?.message ?? error}）`);
    }
    await disposeBrowser(op);
    publish(op);
  }

  async function stepCancelRevoke(op) {
    op.lastStep = 'cancelling';
    assertNotPaused(op);
    await ensurePanel(op);
    const identity = await withTimeout(op.adapter.verifyIdentity(), 10000);
    if (String(identity.userId) !== String(op.userId)) {
      op.error = { code: 'ACCOUNT_CHANGED', message: ERROR_MESSAGES.ACCOUNT_CHANGED, retryTarget: 'cancelling' };
      op.phase = 'login';
      op.control = 'user';
      op.browser?.show();
      publish(op);
      return;
    }
    if (op.tokenId == null && op.intent && op.createDispatch !== 'not-sent') {
      const found = await withTimeout(op.adapter.reconcileCreatedToken({
        tokenName: op.intent.tokenName, group: op.intent.group, userId: op.userId, createdAfterMs: op.createStartedAt,
      }), 20000);
      if (found.status === 'one-owned-token') {
        op.tokenId = found.token.id;
        await journalPersist(op);
      } else {
        op.phase = 'cleanup-pending';
        op.control = 'user';
        op.cleanupPending = { siteOrigin: op.siteOrigin, tokenName: op.intent.tokenName, tokenId: null };
        await journalPersist(op);
        publish(op);
        return;
      }
    }
    if (op.tokenId == null) { await finishCancel(op); return; }
    const result = await withTimeout(op.adapter.revokeToken(op.tokenId), 20000).catch((error) => ({ status: error?.code === 'LOGIN_REQUIRED' ? 'login-required' : 'unknown' }));
    if (result.status === 'revoked-proven' || result.status === 'not-found') {
      op.remoteState = 'revoked';
      await finishCancel(op);
      return;
    }
    if (result.status === 'login-required') {
      op.error = { code: 'LOGIN_REQUIRED', message: '撤销前要先重新登录站点', retryTarget: 'cancelling' };
      op.control = 'user';
      op.phase = 'login';
      publish(op);
      return;
    }
    op.phase = 'cleanup-pending';
    op.control = 'user';
    op.cleanupPending = { siteOrigin: op.siteOrigin, tokenName: op.intent?.tokenName ?? null, tokenId: op.tokenId };
    await journalPersist(op);
    publish(op);
  }

  async function finishCancel(op) {
    op.phase = 'cancelled';
    op.control = 'user';
    op.apiKey = null;
    try {
      await journal.remove(op.operationId);
    } catch (error) {
      log?.warn?.(`导入 ${op.operationId} 取消但 journal 清理失败（${error?.message ?? error}）`);
    }
    await disposeBrowser(op);
    publish(op);
  }

  async function disposeBrowser(op) {
    if (!op.browser) return;
    const browser = op.browser;
    op.browser = null;
    op.browserLoading = null;
    op.siteLoading = false;
    op.witness?.dispose?.();
    op.witness = null;
    op.adapter?.dispose?.();
    op.adapter = null;
    try {
      getMainWindow()?.removeListener?.('hide', op.onWindowHidden);
    } catch { /* ignore */ }
    try {
      const cleanup = browser.dispose();
      browserCleanups.add(cleanup);
      try { await cleanup; } finally { browserCleanups.delete(cleanup); }
    } catch (error) {
      log?.warn?.(`导入 ${op.operationId} 浏览器回收失败（${error?.message ?? error}）`);
    }
  }

  function loginOptions(op) {
    return {
      loginStore,
      onLoginMemoryError(message) {
        if (op.loginMemoryError === message) return;
        op.loginMemoryError = message;
        publish(op);
      },
      onNavigationBlocked() {
        if (active !== op || op.phase !== 'login' || op.siteNavigationBlocked) return;
        op.siteNavigationBlocked = true;
        publishQuiet(op);
      },
      onRenderProcessGone() {
        if (active === op && op.phase === 'login') failOp(op, 'OPEN_SITE');
      },
    };
  }

  /** 站内面板动作前的浏览器保障（恢复站点 profile；失效时仍交给 LOGIN_REQUIRED 流程）。 */
  async function ensurePanel(op) {
    if (op.adapter) return op.browserLoading;
    const mainWindow = getMainWindow();
    if (!mainWindow) throw Object.assign(new Error('主窗口不可用'), { code: 'INTERNAL' });
    op.browser = createImportBrowser({
      createView,
      sessionFromPartition,
      mainWindow,
      siteOrigin: op.siteOrigin,
      ...loginOptions(op),
      onContentReady: contentReadyCallback(op),
    });
    op.siteLoading = true;
    publishQuiet(op);
    op.witness = createAuthWitness({ webRequest: op.browser.session.webRequest, siteOrigin: op.siteOrigin, webContentsId: op.browser.contents.id });
    op.adapter = createNewApiAdapter({ session: op.browser.session, siteOrigin: op.siteOrigin, witness: op.witness, now });
    op.onWindowHidden = op.onWindowHidden ?? (() => {
      if (active === op && op.control === 'hemi') op.abortRequested = true;
    });
    mainWindow.on('hide', op.onWindowHidden);
    op.browserLoading = op.browser.loadInitial(`${op.siteOrigin}/`);
    return op.browserLoading;
  }

  function requireOwner(event) {
    const sender = event?.sender;
    const mainWindow = getMainWindow();
    if (!sender || !mainWindow || sender !== mainWindow.webContents) return false;
    if (event.senderFrame && sender.mainFrame && event.senderFrame !== sender.mainFrame) return false;
    return true;
  }

  function publicState(op) {
    return {
      ...(op.destination ? { destination: op.destination } : {}),
      operationId: op.operationId,
      revision: op.revision,
      phase: op.phase,
      control: op.control,
      siteOrigin: op.siteOrigin,
      apiBaseUrl: op.apiBaseUrl,
      siteLabel: op.siteLabel ?? null,
      accountLabel: op.accountLabel ?? null,
      tokenName: op.intent?.tokenName ?? op.tokenName ?? null,
      groups: op.groups?.map((group) => ({ name: group.name, desc: group.desc })) ?? [],
      candidates: op.candidates?.map((candidate) => ({
        modelName: candidate.modelName,
        apis: candidate.apis,
        unsupported: candidate.unsupported,
      })) ?? [],
      candidatesGroup: op.candidatesGroup ?? null,
      selection: op.selection,
      preview: op.preview
        ? {
          planHash: op.planHash,
          providers: op.preview.providers.map(({ name, api, baseUrl, models }) => ({ name, api, baseUrl, models })),
          firstDefaultModelKey: op.selection?.firstDefaultModelKey ?? null,
        }
        : null,
      progress: PHASE_PROGRESS[op.phase] ?? null,
      validation: op.validation?.results ?? null,
      error: op.error,
      result: op.result,
      cleanupPending: op.cleanupPending ?? null,
      resumeHint: op.resumeHint ?? null,
      loginMemoryError: op.loginMemoryError ?? null,
      /** 站点页首屏加载中：原生视图尚未放出，渲染层画加载动画。 */
      siteLoading: op.siteLoading ?? false,
      siteNavigationBlocked: op.siteNavigationBlocked ?? false,
      can: {
        checkLogin: op.phase === 'login',
        setSelection: op.phase === 'selecting',
        submit: op.phase === 'selecting' && Boolean(op.selection),
        pause: AUTOMATION_PHASES.has(op.phase) && op.control === 'hemi',
        resume: op.control === 'paused',
        retry: op.phase === 'failed' && Boolean(op.error?.retryTarget),
        cancel: !['success', 'cancelled', 'cleanup-pending'].includes(op.phase),
        back: op.phase === 'login' || op.phase === 'selecting' || op.phase === 'failed' ? op.remoteState === 'none' : false,
      },
    };
  }

  return {
    setOwnerSender(send) {
      ownerSender = send;
    },
    async flushLoginMemory() {
      await active?.browser?.flushLoginMemory();
      await Promise.allSettled([...browserCleanups]);
      await loginStore.flush();
    },
    hasLoginMemoryWork() {
      return Boolean(active?.browser || active?.running || browserCleanups.size);
    },
    requireOwner,

    async start(event, { siteUrl, destination }) {
      if (!requireOwner(event)) throw new Error('只有主窗口能发起导入');
      if (destination && (destination.kind !== 'bot' || typeof destination.instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(destination.instanceId))) throw new Error('模型导入目标无效');
      if (destination) await getProfilesStore(destination).list();
      if (active) {
        // 已终态（成功/已取消/待清理）的操作让位；failed 保留可重试。
        if (!['success', 'cancelled', 'cleanup-pending'].includes(active.phase)) {
          const error = new Error('已有进行中的导入操作');
          error.code = 'BUSY';
          throw error;
        }
        await disposeBrowser(active);
        active = null; // cleanup-pending 事实已在 journal，入口走 listPending
      }
      const normalized = normalizeSiteUrl(siteUrl);
      if (!normalized.ok) {
        const error = new Error(normalized.message);
        error.code = normalized.code;
        throw error;
      }
      const mainWindow = getMainWindow();
      if (!mainWindow) throw new Error('主窗口不可用');
      const operationId = newOperationId(now);
      const op = {
        ...(destination ? { destination: { kind: 'bot', instanceId: destination.instanceId } } : {}),
        operationId,
        ownerWebContentsId: mainWindow.webContents.id,
        revision: 0,
        phase: 'opening',
        control: 'user',
        siteOrigin: normalized.siteOrigin,
        apiBaseUrl: normalized.siteOrigin,
        siteLabel: null,
        accountLabel: null,
        userId: null,
        groups: null,
        candidates: null,
        candidatesGroup: null,
        selection: null,
        preview: null,
        planHash: null,
        intent: null,
        tokenName: null,
        tokenId: null,
        remoteState: 'none',
        apiKey: null,
        createDispatch: 'not-sent',
        createStartedAt: null,
        validation: null,
        result: null,
        error: null,
        cleanupPending: null,
        abortRequested: false,
        running: null,
        journaled: false,
        browser: null,
        witness: null,
        adapter: null,
        lastStep: null,
        resumeHint: null,
        onWindowHidden: null,
      };
      active = op;
      try {
        op.browser = createImportBrowser({
          createView,
          sessionFromPartition,
          mainWindow,
          siteOrigin: op.siteOrigin,
          ...loginOptions(op),
          onContentReady: contentReadyCallback(op),
        });
        op.siteLoading = true;
        publishQuiet(op);
        op.witness = createAuthWitness({ webRequest: op.browser.session.webRequest, siteOrigin: op.siteOrigin, webContentsId: op.browser.contents.id });
        op.adapter = createNewApiAdapter({ session: op.browser.session, siteOrigin: op.siteOrigin, witness: op.witness, now });
        // 隐藏主窗时暂停后续页面动作（不静默撤销）。
        op.onWindowHidden = () => {
          if (active === op && op.control === 'hemi') {
            op.abortRequested = true;
          }
        };
        mainWindow.on('hide', op.onWindowHidden);
        op.phase = 'opening';
        publish(op);
        const detected = await withTimeout(op.adapter.detectSite(), 15000).catch(() => null);
        if (!detected) {
          failOp(op, 'UNSUPPORTED');
          return { ok: true, state: publicState(op) };
        }
        op.siteLabel = detected.systemName ?? new URL(op.siteOrigin).hostname;
        op.phase = 'login';
        op.control = 'user';
        publish(op);
        try {
          op.browserLoading = op.browser.loadInitial(`${op.siteOrigin}/`);
          await op.browserLoading;
        } catch (_error) {
          if (active === op && op.phase === 'login') failOp(op, 'OPEN_SITE');
        }
        return { ok: true, state: publicState(op) };
      } catch (error) {
        failOp(op, error?.code && ERROR_MESSAGES[error.code] ? error.code : 'INTERNAL', {});
        return { ok: true, state: publicState(op) };
      }
    },

    getState(_event, { operationId = null } = {}) {
      if (!active) return { ok: true, state: null };
      if (operationId && active.operationId !== operationId) return { ok: true, state: null };
      return { ok: true, state: publicState(active) };
    },

    async listPending() {
      const pending = await journal.list();
      return {
        ok: true,
        activeOperationId: active?.operationId ?? null,
        pending: pending.filter((item) => item.operationId !== active?.operationId || active.phase === 'cleanup-pending'),
      };
    },

    async checkLogin(event, { operationId, revision }) {
      if (!requireOwner(event)) throw new Error('只有主窗口能操作导入');
      const op = active;
      if (!op || op.operationId !== operationId) throw new Error('没有这个导入操作');
      if (typeof revision === 'number' && revision !== op.revision) {
        const error = new Error('状态已变化，请刷新后重试');
        error.code = 'STALE_REVISION';
        throw error;
      }
      if (op.phase !== 'login') throw new Error('当前阶段不需要登录核验');
      const retryTarget = op.error?.retryTarget ?? null;
      try {
        await ensurePanel(op);
        // 页面交给用户登录；这里只在「页面不在站点内」时拉回站点根（不硬编码
        // 令牌页路由——vvcode 的 /console/token 是 404，各站路由不一致）。
        if (op.browser && URL.parse(op.browser.contents.getURL())?.origin !== op.siteOrigin) {
          await op.browser.contents.loadURL(`${op.siteOrigin}/`).catch(() => undefined);
        }
        let identity = null;
        try {
          identity = await withTimeout(op.adapter.verifyIdentity(), 10000);
        } catch (error) {
          if (error?.code !== 'LOGIN_REQUIRED') throw error;
          // 见证可能落在登录完成前：重载当前页让站点自发管理请求，再等一轮头。
          const baseline = op.witness.get().at;
          const current = op.browser.contents.getURL();
          await op.browser.contents.loadURL(current || `${op.siteOrigin}/`).catch(() => undefined);
          const updated = await op.witness.waitForUpdate(9000, undefined, baseline);
          if (updated) identity = await withTimeout(op.adapter.verifyIdentity(), 10000);
        }
        if (!identity) {
          return { ok: false, code: 'LOGIN_REQUIRED', message: ERROR_MESSAGES.LOGIN_REQUIRED, state: publicState(op) };
        }
        if (op.userId != null && String(identity.userId) !== String(op.userId)) {
          return { ok: false, code: 'ACCOUNT_CHANGED', message: ERROR_MESSAGES.ACCOUNT_CHANGED, state: publicState(op) };
        }
        op.userId = String(identity.userId);
        op.accountLabel = identity.username ? `${identity.username}（#${identity.userId}）` : `#${identity.userId}`;
        await op.browser?.confirmLogin(identity);
        if (retryTarget) {
          // 自动化中途失效的恢复：从断点继续（不重新创建）。
          op.error = null;
          op.abortRequested = false;
          op.control = 'hemi';
          op.phase = retryTarget;
          publish(op);
          void continuePipeline(op);
          return { ok: true, state: publicState(op) };
        }
        op.phase = 'discovering';
        publish(op);
        const groups = await withTimeout(op.adapter.readAuthorizedGroups(), 15000);
        if (!groups.length) {
          failOp(op, 'NO_GROUPS');
          return { ok: true, state: publicState(op) };
        }
        op.groups = groups;
        let catalogUnavailable = false;
        if (groups.length === 1) {
          try {
            await loadModelCandidates(op, groups[0].name);
          } catch (_error) {
            catalogUnavailable = true;
          }
        }
        op.phase = 'selecting';
        op.error = null;
        publish(op);
        if (catalogUnavailable) return { ok: false, code: 'CATALOG_UNAVAILABLE', state: publicState(op) };
        return { ok: true, state: publicState(op) };
      } catch (error) {
        if (error?.code === 'LOGIN_REQUIRED') {
          return { ok: false, code: 'LOGIN_REQUIRED', message: ERROR_MESSAGES.LOGIN_REQUIRED, state: publicState(op) };
        }
        failOp(op, error?.code && ERROR_MESSAGES[error.code] ? error.code : 'INTERNAL', {});
        return { ok: false, code: 'INTERNAL', message: ERROR_MESSAGES.INTERNAL, state: publicState(op) };
      }
    },

    async setSelection(event, { operationId, revision, selection }) {
      if (!requireOwner(event)) throw new Error('只有主窗口能操作导入');
      const op = active;
      if (!op || op.operationId !== operationId) throw new Error('没有这个导入操作');
      if (op.phase !== 'selecting') throw new Error('当前阶段不能修改选择');
      if (typeof revision === 'number' && revision !== op.revision) {
        const error = new Error('状态已变化，请刷新后重试');
        error.code = 'STALE_REVISION';
        throw error;
      }
      const group = String(selection?.group ?? '');
      if (!op.groups?.some((item) => item.name === group)) throw new Error('没有这个分组');
      const budgetMode = selection?.budgetMode === 'usd' ? 'usd' : 'unlimited';
      const budgetUsd = Number(selection?.budgetUsd);
      if (budgetMode === 'usd' && (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 10000)) {
        throw new Error('额度要在 0–10000 美元之间');
      }
      const expiryMode = selection?.expiryMode === 'days' ? 'days' : 'never';
      const expiryDays = Number(selection?.expiryDays);
      if (expiryMode === 'days' && (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 3650)) {
        throw new Error('有效期要在 1–3650 天之间');
      }
      const rawModels = Array.isArray(selection?.models) ? selection.models : [];

      // 候选按当前组实时读站点（切组后旧型号草稿不沿）。空模型也允许同步——
      // 分组一选定就回候选列表供勾选；「至少一个模型」的门槛在提交。
      try {
        await loadModelCandidates(op, group);
      } catch (_error) {
        return { ok: false, code: 'CATALOG_UNAVAILABLE', state: publicState(op) };
      }
      if (!rawModels.length) {
        op.selection = null;
        op.preview = null;
        op.planHash = null;
        publish(op);
        return { ok: true, state: publicState(op) };
      }
      const models = [];
      for (const raw of rawModels) {
        const modelName = String(raw?.modelName ?? '');
        const candidate = op.candidates.find((item) => item.modelName === modelName);
        if (!candidate) throw new Error(`「${modelName}」不在这个分组里`);
        // Prefer Chat Completions when the site advertises both supported APIs.
        const api = raw?.api === undefined
          ? (candidate.apis.includes('openai-completions') ? 'openai-completions' : candidate.apis[0])
          : raw.api;
        if (!candidate.apis.includes(api)) throw new Error(`「${modelName}」不支持所选协议`);
        if (models.some((item) => item.modelName === modelName)) continue;
        models.push({ modelName, api });
      }
      const firstDefaultModelKey = typeof selection?.firstDefaultModelKey === 'string' ? selection.firstDefaultModelKey : null;
      op.selection = { group, budgetMode, ...(budgetMode === 'usd' ? { budgetUsd } : {}), expiryMode, ...(expiryMode === 'days' ? { expiryDays } : {}), models, firstDefaultModelKey };
      op.preview = buildPreview(op, op.selection);
      op.planHash = op.preview.planHash;
      publish(op);
      return { ok: true, state: publicState(op) };
    },

    async submit(event, { operationId, revision, planHash }) {
      if (!requireOwner(event)) throw new Error('只有主窗口能操作导入');
      const op = active;
      if (!op || op.operationId !== operationId) throw new Error('没有这个导入操作');
      if (op.phase !== 'selecting') throw new Error('当前阶段不能提交');
      if (typeof revision === 'number' && revision !== op.revision) {
        const error = new Error('状态已变化，请刷新后重试');
        error.code = 'STALE_REVISION';
        throw error;
      }
      if (!op.selection || !op.preview) throw new Error('先完成分组与模型选择');
      if (planHash !== op.planHash) throw new Error('提交的计划和当前预览不一致，请重新确认');
      if (op.running) throw new Error('上一次提交还在进行');
      op.control = 'hemi';
      op.abortRequested = false;
      op.error = null;
      op.phase = 'preflight';
      publish(op);
      void continuePipeline(op);
      return { ok: true, state: publicState(op) };
    },

    async retry(event, { operationId, revision, target }) {
      if (!requireOwner(event)) throw new Error('只有主窗口能操作导入');
      const op = active;
      if (!op || op.operationId !== operationId) throw new Error('没有这个导入操作');
      if (typeof revision === 'number' && revision !== op.revision) {
        const error = new Error('状态已变化，请刷新后重试');
        error.code = 'STALE_REVISION';
        throw error;
      }
      if (op.phase !== 'failed' || !op.error?.retryTarget) throw new Error('当前没有可重试的失败');
      const retryTarget = target ?? op.error.retryTarget;
      if (!['preflight', 'reconciling', 'reading-key', 'validating', 'saving', 'cancelling'].includes(retryTarget)) {
        throw new Error('这个阶段不能作为重试入口');
      }
      op.error = null;
      op.control = 'hemi';
      op.abortRequested = false;
      op.phase = retryTarget;
      publish(op);
      void continuePipeline(op);
      return { ok: true, state: publicState(op) };
    },

    async pause(event, { operationId, revision }) {
      if (!requireOwner(event)) throw new Error('只有主窗口能操作导入');
      const op = active;
      if (!op || op.operationId !== operationId) throw new Error('没有这个导入操作');
      if (typeof revision === 'number' && revision !== op.revision) {
        const error = new Error('状态已变化，请刷新后重试');
        error.code = 'STALE_REVISION';
        throw error;
      }
      if (op.control !== 'hemi') throw new Error('只有自动执行阶段可以暂停');
      op.abortRequested = true;
      return { ok: true, state: publicState(op) };
    },

    async resume(event, { operationId, revision }) {
      if (!requireOwner(event)) throw new Error('只有主窗口能操作导入');
      const op = active;
      if (!op || op.operationId !== operationId) throw new Error('没有这个导入操作');
      if (typeof revision === 'number' && revision !== op.revision) {
        const error = new Error('状态已变化，请刷新后重试');
        error.code = 'STALE_REVISION';
        throw error;
      }
      if (op.control !== 'paused') throw new Error('当前不在暂停状态');
      op.abortRequested = false;
      op.control = 'hemi';
      publish(op);
      void continuePipeline(op);
      return { ok: true, state: publicState(op) };
    },

    async cancel(event, { operationId, revision }) {
      if (!requireOwner(event)) throw new Error('只有主窗口能操作导入');
      const op = active;
      if (!op || op.operationId !== operationId) throw new Error('没有这个导入操作');
      if (typeof revision === 'number' && revision !== op.revision) {
        const error = new Error('状态已变化，请刷新后重试');
        error.code = 'STALE_REVISION';
        throw error;
      }
      if (['success', 'cancelled'].includes(op.phase)) throw new Error('这个操作已经结束');
      if (op.running && op.phase !== 'login') {
        // 自动化进行中：先请求暂停，等边界处停下再取消（coordinator 串行结算）。
        op.abortRequested = true;
        await op.running.catch(() => undefined);
        op.abortRequested = false; // 撤销管线自身要能跑（真站在途取消实测钓出的坑）
      }
      if (op.phase === 'success') return { ok: true, state: publicState(op) };
      if (op.intent && op.createDispatch !== 'not-sent') {
        // A lost Host response can follow a committed write. Never revoke its key.
        const receipt = await getProfilesStore(op.destination).findImportReceipt(op.operationId);
        if (receipt) {
          op.phase = 'success';
          op.control = 'user';
          op.result = { providerIds: receipt.providerIds, modelKeys: receipt.modelKeys, encrypted: true };
          op.apiKey = null;
          await journal.remove(op.operationId);
          await disposeBrowser(op);
          publish(op);
          return { ok: true, state: publicState(op) };
        }
      }
      if (op.remoteState === 'created' || op.remoteState === 'unknown' || op.tokenId != null
        || (op.intent && op.createDispatch !== 'not-sent')) {
        await journalPersist(op, { cancelRequested: true, phase: 'cancelling' });
        op.cancelRequested = true;
        op.control = 'hemi';
        op.phase = 'cancelling';
        op.error = null;
        publish(op);
        void continuePipeline(op);
        return { ok: true, state: publicState(op) };
      }
      await finishCancel(op);
      return { ok: true, state: publicState(op) };
    },

    /**
     * 断点恢复（崩溃/退出后）：先读目录回执（提交事实权威）——有回执＝已导入，
     * 清残留秘密即结算；再读 journal 按事实分叉：已持 Key → 直接验证/保存；
     * 已派发/已建 → 重登同一账号后查证；未派发 → 重登后从 preflight 继续。
     */
    async resumePending(event, { operationId }) {
      if (!requireOwner(event)) throw new Error('只有主窗口能恢复导入');
      if (active) {
        if (!['success', 'cancelled', 'cleanup-pending'].includes(active.phase)) throw new Error('先处理当前进行中的导入');
        await disposeBrowser(active);
        active = null;
      }
      const read = await journal.read(operationId);
      if (!read) throw new Error('没有这个待处理导入');
      if (!read.ok) {
        const error = new Error('导入记录无法解密，恢复不可用（记录已保留）');
        error.code = 'JOURNAL_CORRUPT';
        throw error;
      }
      const payload = read.payload ?? {};
      // 回执优先：已提交的导入不撤销，直接结算。
      let receipt = null;
      try {
        receipt = await getProfilesStore(payload.destination).findImportReceipt(operationId);
      } catch {
        throw new Error('无法核对模型导入回执，请恢复与 Harness Host 的连接后重试。');
      }
      if (receipt) {
        await journal.remove(operationId);
        return {
          ok: true,
          settled: 'already-committed',
          state: {
            operationId,
            phase: 'success',
            result: { providerIds: receipt.providerIds, modelKeys: receipt.modelKeys, encrypted: true },
          },
        };
      }
      const op = {
        ...(payload.destination ? { destination: payload.destination } : {}),
        operationId,
        ownerWebContentsId: event?.sender?.id ?? 0,
        revision: 0,
        phase: 'login',
        control: 'user',
        siteOrigin: payload.siteOrigin,
        apiBaseUrl: payload.apiBaseUrl ?? payload.siteOrigin,
        siteLabel: null,
        accountLabel: payload.accountLabel ?? null,
        userId: payload.userId ?? null,
        groups: null,
        candidates: null,
        candidatesGroup: null,
        selection: null,
        preview: null,
        planHash: payload.planHash ?? null,
        intent: payload.intent ?? null,
        tokenName: payload.intent?.tokenName ?? null,
        tokenId: payload.tokenId ?? null,
        remoteState: payload.remoteState ?? 'none',
        apiKey: payload.apiKey ?? null,
        createDispatch: payload.createDispatch ?? 'not-sent',
        cancelRequested: payload.cancelRequested === true || ['cancelling', 'cleanup-pending'].includes(payload.phase),
        createStartedAt: payload.createStartedAt ?? null,
        validation: payload.validation ?? null,
        result: null,
        error: null,
        cleanupPending: null,
        abortRequested: false,
        running: null,
        journaled: true,
        browser: null,
        witness: null,
        adapter: null,
        lastStep: null,
        resumeHint: null,
        onWindowHidden: null,
      };
      if (op.intent) {
        op.selection = {
          group: op.intent.group,
          budgetMode: op.intent.budgetMode ?? 'unlimited',
          ...(op.intent.budgetMode === 'usd' ? { budgetUsd: op.intent.budgetUsd } : {}),
          expiryMode: op.intent.expiryMode ?? 'never',
          ...(op.intent.expiryMode === 'days' ? { expiryDays: op.intent.expiryDays } : {}),
          models: op.intent.models ?? [],
          firstDefaultModelKey: op.intent.firstDefaultModelKey ?? null,
        };
        op.preview = buildPreview(op, op.selection);
        op.planHash = op.planHash ?? op.preview.planHash;
      }
      active = op;
      const hasKey = Boolean(op.apiKey);
      const dispatched = op.createDispatch === 'may-have-been-sent' || op.createDispatch === 'acknowledged';
      if (hasKey && !op.cancelRequested) {
        // Key 已加密留存：验证/保存不需要站点面板，直接续跑。
        op.resumeHint = '检测到上次已读取的 Key，继续验证与保存';
        op.phase = 'validating';
        op.control = 'hemi';
        publish(op);
        void continuePipeline(op);
        return { ok: true, state: publicState(op) };
      }
      const continueAt = op.cancelRequested ? 'cancelling'
        : op.tokenId != null ? 'reading-key' : dispatched ? 'reconciling' : op.intent ? 'preflight' : null;
      if (!continueAt) {
        // journal 只有站点/账号、没有冻结 intent：等登录后重选（phase login → selecting）。
        op.resumeHint = '上次导入在创建前中断；重新登录后重新选择分组与模型';
        publish(op);
        return { ok: true, state: publicState(op) };
      }
      op.error = { code: 'LOGIN_REQUIRED', message: '登录同一账号后从中断处继续', retryTarget: continueAt };
      op.resumeHint = op.cancelRequested ? '登录同一账号后继续清理令牌' : '登录同一账号后从中断处继续（不会重复创建）';
      publish(op);
      return { ok: true, state: publicState(op) };
    },

    async setBrowserBounds(event, { operationId, bounds }) {
      if (!requireOwner(event)) throw new Error('只有主窗口能显示站点登录页面');
      const op = active;
      if (op?.operationId !== operationId || op.phase !== 'login') return { ok: true };
      if (bounds === null) {
        op.browser?.hide();
        return { ok: true };
      }
      // ensurePanel installs the view synchronously before awaiting its first document.
      // A later bounds update or close always wins while that document is loading.
      const loading = ensurePanel(op);
      op.browser?.setBounds(bounds);
      try {
        await loading;
      } catch (_error) {
        if (active === op && op.phase === 'login') failOp(op, 'OPEN_SITE');
      }
      return { ok: true };
    },

    focusBrowser(event, { operationId }) {
      if (!requireOwner(event)) throw new Error('只有主窗口能聚焦站点登录页面');
      if (active && active.operationId === operationId && active.phase === 'login') active.browser?.focus();
      return { ok: true };
    },

    /** 退出前回收：只停操作/收浏览器，不依赖这次异步写保事务（journal 已在各边界 durable）。 */
    async disposeForQuit() {
      const op = active;
      if (!op) return;
      op.abortRequested = true;
      await op.running?.catch(() => undefined);
      try {
        getMainWindow()?.removeListener?.('hide', op.onWindowHidden);
      } catch { /* ignore */ }
      await disposeBrowser(op);
    },

  };
}
