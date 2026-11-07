/** Conversation-wide cache summary and per-model detail, owned entirely by Hemi. */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationUsage, ModelUsageRow } from '@deepseek-ai/dsh-hemi-routing/client'
import { NS } from '../locales.ts'
import { UsagePopover } from './UsagePanel.tsx'
import { useStatDialog } from './stat-dialog.ts'
import { conversationCacheHit, formatCacheHit } from './conversation-usage.ts'
import type { CacheHitRate } from './conversation-usage.ts'
import css from './Usage.module.css'

type Props = PropsRuntime<'conversation.composer.dock'> & PropsLocale<typeof NS> & SessionUsageInjected
type Translate = PropsLocale<typeof NS>['t']
export interface SessionUsageInjected {
  loadUsage(this: void, signal: AbortSignal): Promise<ConversationUsage>
}
type UsageRead = {
  reader: SessionUsageInjected['loadUsage']
  data: ConversationUsage | undefined
  failed: boolean
}
const exact = new Intl.NumberFormat()

function metric(value: number, reports: number, calls: number): string {
  return reports === 0 || reports < calls ? '—' : exact.format(value)
}

function cacheRateText(cache: CacheHitRate | undefined, t: Translate): string {
  const rate = formatCacheHit(cache)
  return cache !== undefined && cache.reportedCalls < cache.calls
    ? t('usage.cachePartialRate', { rate, reported: exact.format(cache.reportedCalls), calls: exact.format(cache.calls) })
    : rate
}

export function HemiSessionUsage(props: Props) {
  const { t, loadUsage } = props
  const rootUsage = props.useProjection('hemiModelUsage')
  const catalog = props.useProjection('subagentCatalog')
  const hasChildren = (catalog?.length ?? 0) > 0
  const dialog = useStatDialog()
  const [read, setRead] = useState<UsageRead>()
  // Retained figures belong to the injected Session reader, never another conversation.
  const loaded = read?.reader === loadUsage ? read : undefined
  const failed = hasChildren && loaded?.failed === true
  const open = dialog.open
  useEffect(() => {
    // A solo session already has a live projection. A tree also refreshes while
    // collapsed, since a background child can finish after its parent is idle.
    if (!hasChildren) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const failRead = (): void => {
      setRead(current => ({
        reader: loadUsage, data: current?.reader === loadUsage ? current.data : undefined, failed: true,
      }))
    }
    const refresh = async (): Promise<void> => {
      try {
        const next = await loadUsage(controller.signal)
        if (controller.signal.aborted) return
        // The tree reader reports root RPC failures as a tree with no readable sessions.
        if (next.sessions === 0 && next.unavailableSessions > 0) failRead()
        else setRead({ reader: loadUsage, data: next, failed: false })
      } catch (_error) {
        if (!controller.signal.aborted) failRead()
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(() => { void refresh() }, open ? 3000 : 8000)
        }
      }
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [open, hasChildren, rootUsage, catalog, loadUsage])

  const data: ConversationUsage | undefined = hasChildren ? loaded?.data
    : rootUsage === undefined ? undefined : { models: rootUsage.models, sessions: 1, unavailableSessions: 0 }
  const rows = data?.models ?? []
  if ((rootUsage?.models.length ?? 0) === 0 && !hasChildren) return null
  const title = t('usage.session')
  const totalKnown = data !== undefined && data.unavailableSessions === 0 && rows.length > 0
    && rows.every(row => row.totalReports === row.calls)
  const total = rows.reduce((sum, row) => sum + row.totalTokens, 0)
  const cache = data === undefined ? undefined : conversationCacheHit(rows, data.unavailableSessions)
  const cacheRate = formatCacheHit(cache)
  const partial = cache !== undefined && cache.reportedCalls < cache.calls
  const trigger = t('usage.cacheSummary', { rate: cacheRate })
  return <UsagePopover dialog={dialog} title={title} trigger={trigger} wide keepLabel>
    <div className={css.summary}>
      <span>{t('usage.total')} <strong>{totalKnown ? exact.format(total) : '—'}</strong> {t('usage.unit')}</span>
      <span>{t('usage.cacheSummary', { rate: cacheRate })}</span>
    </div>
    {partial && <p className={css.scope}>{t('usage.reportedCoverage', {
      reported: exact.format(cache.reportedCalls), calls: exact.format(cache.calls),
    })}</p>}
    {data !== undefined && data.unavailableSessions > 0 && <p className={css.scope}>
      {t('usage.missingSessions', { count: exact.format(data.unavailableSessions) })}
    </p>}
    {(failed || (hasChildren && data === undefined)) && <div role="status" className={css.status}>
      {failed ? t(data === undefined ? 'usage.readFailed' : 'usage.refreshFailed') : t('usage.loading')}
    </div>}
    {rows.length > 0 && <table className={css.models}>
      <caption className={css.srOnly}>{t('usage.byModel')}</caption>
      <thead><tr>
        <th scope="col">{t('usage.model')}</th>
        <th scope="col">{t('usage.calls')}</th>
        <th scope="col">{t('usage.fullInput')}</th>
        <th scope="col">{t('usage.output')}</th>
        <th scope="col">{t('usage.cacheRate')}</th>
        <th scope="col">{t('usage.cacheRead')}</th>
        <th scope="col">{t('usage.cacheWrite')}</th>
      </tr></thead>
      <tbody>{rows.map(row => <ModelRow key={JSON.stringify([row.provider, row.model])} row={row} t={t} />)}</tbody>
    </table>}
    {data !== undefined && rows.length === 0 && <p className={css.scope}>{t('usage.unavailable')}</p>}
  </UsagePopover>
}

function ModelRow({ row, t }: { row: ModelUsageRow; t: Translate }) {
  return <tr>
    <th scope="row">{row.model} ({row.provider})</th>
    <td data-label={t('usage.calls')}>{exact.format(row.calls)}</td>
    <td data-label={t('usage.fullInput')}>{metric(row.totalTokens - row.outputTokens, row.totalReports, row.calls)}</td>
    <td data-label={t('usage.output')}>{metric(row.outputTokens, row.reportedCalls, row.calls)}</td>
    <td data-label={t('usage.cacheRate')}>{cacheRateText(conversationCacheHit([row]), t)}</td>
    <td data-label={t('usage.cacheRead')}>{metric(row.cacheReadTokens, row.cacheReadReports, row.calls)}</td>
    <td data-label={t('usage.cacheWrite')}>{metric(row.cacheWriteTokens, row.cacheWriteReports, row.calls)}</td>
  </tr>
}
