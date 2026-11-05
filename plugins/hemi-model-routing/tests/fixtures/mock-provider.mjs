// Keyless external-provider fixture for the real model-routing UI smoke.
import { appendFileSync, existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

const MODELS = [
  ['fixed', '验证 · 固定型号'],
  ['main', '验证 · 主模型'],
  ['explorer', '验证 · 研究模型'],
  ['oracle', '验证 · 评审模型'],
  ['fixer', '验证 · 执行模型'],
  ['designer', '验证 · 设计模型'],
]

function textOf(message) {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

class RoutingProbeAdapter extends LlmAdapter {
  constructor(ctx, logPath) {
    super()
    this.ctx = ctx
    this.logPath = logPath
  }

  providerInfo(provider) {
    return { id: provider, name: 'Hemi 路由验证（模拟提供方）' }
  }

  async listModels(provider) {
    return MODELS.map(([id, name]) => ({ provider, id, name }))
  }

  async resolveModel(provider, model) {
    const named = MODELS.find(([id]) => id === model)
    if (named === undefined) throw new Error(`Unknown routing probe model: ${model}`)
    return { provider, id: model, name: named[1], context: { contextWindow: 128_000 }, inputModalities: ['text'] }
  }

  async *stream(options) {
    const userMessages = options.messages.filter(message => message.role === 'user')
    const agent = options.sessionId === undefined ? undefined : this.ctx.agents.get(options.sessionId)
    const childTask = userMessages.map(textOf).findLast(text => /ROUTING_CHILD_ONLY:([a-z]+):([\w-]+)/.test(text))
    const childMatch = agent?.session.header.origin !== 'subagent' || childTask === undefined
      ? null : /ROUTING_CHILD_ONLY:([a-z]+):([\w-]+)/.exec(childTask)
    const parentTask = userMessages.map(textOf).findLast(text => /ROUTING_SMOKE:([a-z]+):([\w-]+)/.test(text))
    const roleToolAvailable = options.tools?.some(tool => tool.name === 'subagent') === true
    const parentMatch = agent === undefined || !roleToolAvailable || parentTask === undefined
      ? null : /ROUTING_SMOKE:([a-z]+):([\w-]+)/.exec(parentTask)
    const observed = {
      provider: options.provider,
      model: options.model,
      sessionId: options.sessionId ?? null,
      kind: childMatch === null ? 'parent' : 'child',
      role: childMatch?.[1] ?? parentMatch?.[1] ?? null,
      caseId: childMatch?.[2] ?? parentMatch?.[2] ?? null,
    }
    appendFileSync(this.logPath, JSON.stringify(observed) + '\n', { mode: 0o600 })
    if (childMatch !== null) {
      if (childMatch[2] === 'auto-fixer') {
        const deadline = Date.now() + 15000
        while (!existsSync(`${this.logPath}.release-fixer`)) {
          if (Date.now() >= deadline) throw new Error('The native fixer probe was not released')
          await sleep(50, undefined, { signal: options.signal })
        }
      }
      yield* textChunks(`路由验证：${childMatch[1]} 子任务实际使用 ${options.provider}/${options.model}`)
      return
    }
    if (parentMatch !== null) {
      const [, role, caseId] = parentMatch
      const callId = ToolCallId(`routing-${caseId}-${role}`)
      const alreadyCalled = options.messages.some(message => message.role === 'assistant'
        && message.content.some(block => block.type === 'tool-call' && block.id === callId))
      if (!alreadyCalled) {
        const args = JSON.stringify({ agent_preset: role, description: `验证${role}模型绑定`, prompt: `ROUTING_CHILD_ONLY:${role}:${caseId}\n只报告当前模型，不调用任何工具` })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: callId, name: 'subagent', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'subagent', arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const received = userMessages.some(message => textOf(message).includes(`路由验证：${role} 子任务实际使用`))
      yield* textChunks(`路由验证：主请求使用 ${options.provider}/${options.model}，${received ? '已收到' : '等待'} ${role} 子任务结果`)
      return
    }
    yield* textChunks(`路由验证：当前请求使用 ${options.provider}/${options.model}`)
  }
}

export const name = 'hemi-routing-keyless-provider'
export const inject = ['llm', 'agents']
export function apply(ctx, config) {
  if (typeof config.logPath !== 'string' || config.logPath === '') throw new Error('Routing probe needs a logPath')
  ctx.llm.registerAdapter(['routing-probe'], new RoutingProbeAdapter(ctx, config.logPath))
}
