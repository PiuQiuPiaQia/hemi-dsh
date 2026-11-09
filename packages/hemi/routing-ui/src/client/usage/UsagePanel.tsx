/** Hemi usage details for the current agent and historical synchronous role calls. */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconDatabaseOutlineRegular, MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NS } from '../locales.ts'
import { useStatDialog } from './stat-dialog.ts'
import css from './Usage.module.css'

type Translate = PropsLocale<typeof NS>['t']
type TurnProps = PropsRuntime<'conversation.chat.turnUsage'> & PropsLocale<typeof NS>
type ChildUsage = { readonly id: SessionId; readonly role: string; readonly total: number | undefined }

function totalOf(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

function childKeys(snapshot: ChatSnapshot, turn: number): string {
  const children = new Map<string, string>()
  for (const key of snapshot.locations.getTurn(turn)) {
    const node = snapshot.nodes.get(key) as ChatNode | undefined
    if (node?.kind !== 'tool-call') continue
    const tool = node.data.root
    if (!('kind' in tool) || tool.isError) continue
    const meta = tool.meta
    if (typeof meta !== 'object' || meta === null || !('kind' in meta)
      || !('subagentId' in meta) || typeof meta.subagentId !== 'string' || meta.subagentId === '') continue
    // Keep older custom-tool histories readable alongside native role receipts.
    const role = tool.name === 'hemi_delegate' && meta.kind === 'result' && 'role' in meta ? meta.role
      : tool.name === 'subagent' && meta.kind === 'activation' && 'completed' in meta && meta.completed === true
        && 'agentPreset' in meta ? meta.agentPreset : undefined
    if (typeof role === 'string') children.set(meta.subagentId, role)
  }
  return JSON.stringify([...children])
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const exact = new Intl.NumberFormat()

function UsageRows({ usage, t }: {
  usage: {
    uncachedInputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
  t: Translate
}) {
  const prompt = usage.totalTokens - usage.outputTokens
  const otherInput = prompt - usage.uncachedInputTokens
    - (usage.cacheReadTokens ?? 0) - (usage.cacheWriteTokens ?? 0)
  return <>
    <dt>{t('usage.input')}</dt><dd>{exact.format(usage.uncachedInputTokens)}</dd>
    {usage.cacheReadTokens !== undefined && <>
      <dt>{t('usage.cacheRead')}</dt><dd>{exact.format(usage.cacheReadTokens)}</dd>
    </>}
    {usage.cacheWriteTokens !== undefined && usage.cacheWriteTokens > 0 && <>
      <dt>{t('usage.cacheWrite')}</dt><dd>{exact.format(usage.cacheWriteTokens)}</dd>
    </>}
    {otherInput > 0 && <><dt>{t('usage.unsplitCache')}</dt><dd>{exact.format(otherInput)}</dd></>}
    {usage.cacheReadTokens !== undefined && prompt > 0 && <>
      <dt>{t('usage.cacheHit')}</dt><dd>{cachePercent(usage.cacheReadTokens, prompt)}</dd>
    </>}
    <dt>{t('usage.output')}</dt><dd>{exact.format(usage.outputTokens)}</dd>
    {usage.reasoningTokens !== undefined && <>
      <dt>{t('usage.reasoning')}</dt><dd>{exact.format(usage.reasoningTokens)}</dd>
    </>}
  </>
}

function cachePercent(read: number, input: number): string {
  const ratio = read / input
  if (read < input && ratio >= 0.9995) return '<100%'
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(ratio)
}

export interface TurnUsageInjected {
  loadChildUsage(this: void, id: SessionId, signal: AbortSignal): Promise<TokenUsageProjection | undefined>
}

/**
 * Show parent buckets and the independently recorded usage of historical synchronous role calls.
 * @param props - completed turn, scoped chat state, locale, and child projection reader.
 * @returns the turn usage action, or null when the turn has no known usage.
 */
export function HemiTurnUsage(props: TurnProps & TurnUsageInjected) {
  const { usage, turn, loadChildUsage, t } = props
  const keys = props.useChat(snapshot => childKeys(snapshot, turn))
  const dialog = useStatDialog()
  const [loaded, setLoaded] = useState<{ keys: string; children: ChildUsage[] }>()
  const hasChildren = keys !== '[]'
  const children = loaded?.keys === keys ? loaded.children : undefined
  const complete = children?.every(child => child.total !== undefined) === true
  const combined = usage !== undefined && complete
    ? usage.totalTokens + children.reduce((sum, child) => sum + (child.total ?? 0), 0)
    : undefined
  const open = dialog.open

  useEffect(() => {
    if (!open || !hasChildren || children !== undefined) return
    const controller = new AbortController()
    const entries = JSON.parse(keys) as [SessionId, string][]
    void Promise.all(entries.map(async ([id, role]): Promise<ChildUsage> => {
      try {
        const reported = await loadChildUsage(id, controller.signal)
        return { id, role, total: reported === undefined ? undefined : totalOf(reported) }
      } catch (_error) {
        return { id, role, total: undefined }
      }
    })).then((next) => {
      if (!controller.signal.aborted) setLoaded({ keys, children: next })
    })
    return () => { controller.abort() }
  }, [children, hasChildren, keys, loadChildUsage, open])

  if (usage === undefined && !hasChildren) return null
  const title = t('usage.turn')
  const trigger = combined === undefined
    ? hasChildren || usage === undefined ? title : t('usage.tokens', { count: compact.format(usage.totalTokens) })
    : t('usage.tokens', { count: compact.format(combined) })
  return (
    <UsagePopover dialog={dialog} title={title} trigger={trigger}>
      <dl className={css.details}>
        <dt className={css.heading}>{t('usage.currentAgent')}</dt>
        <dd>{usage === undefined ? t('usage.unavailable') : exact.format(usage.totalTokens)}</dd>
        {usage?.routes !== undefined && <>
          <dt>{t('usage.model')}</dt>
          <dd>{usage.routes.map(route => `${route.provider}/${route.model}`).join(', ')}</dd>
        </>}
        {usage !== undefined && <UsageRows usage={usage} t={t} />}
        {hasChildren && <>
          <dt className={css.heading}>{t('usage.delegated')}</dt>
          <dd role="status">{children === undefined ? t('usage.loading') : null}</dd>
          {children?.map(child => <UsageChildRow key={child.id} child={child} t={t} />)}
          {combined !== undefined && <>
            <dt className={css.heading}>{t('usage.recordedTotal')}</dt><dd>{exact.format(combined)}</dd>
          </>}
        </>}
      </dl>
    </UsagePopover>
  )
}

function UsageChildRow({ child, t }: { child: ChildUsage; t: Translate }) {
  return <><dt>{child.role}</dt><dd>{child.total === undefined ? t('usage.unavailable') : exact.format(child.total)}</dd></>
}

export function UsagePopover({ dialog, title, trigger, children, wide = false, keepLabel = false }: {
  dialog: ReturnType<typeof useStatDialog>
  title: string
  trigger: string
  children: React.ReactNode
  wide?: boolean
  keepLabel?: boolean
}) {
  const { open, setOpen, rootRef, panelRef, anchorStyle } = dialog
  return (
    <span ref={rootRef} className={`${css.root}${keepLabel ? ` ${css.keepLabel}` : ''}`} style={anchorStyle}>
      <button type="button" className={css.trigger} aria-label={title} aria-haspopup="dialog"
        aria-description={trigger === title ? undefined : trigger}
        aria-expanded={open} onClick={() => { setOpen(!open) }}>
        <IconDatabaseOutlineRegular /><span className={css.label}>{trigger}</span>
      </button>
      {open && createPortal(
        <MenuSurface ref={panelRef} role="dialog" aria-label={title} className={`${css.panel}${wide ? ` ${css.wide}` : ''}`} style={anchorStyle}>
          <div className={css.title}>{title}</div>
          {children}
        </MenuSurface>,
        document.body,
      )}
    </span>
  )
}
