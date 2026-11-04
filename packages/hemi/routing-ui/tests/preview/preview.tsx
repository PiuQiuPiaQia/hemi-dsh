/** Real routing components with inert test data for theme and viewport review. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ICON_SYMBOLS, MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import { RoutingDialog, type RoutingDialogProps } from '../../src/client/RoutingDialog.tsx'
import { RoutingModeToggle, type RoutingModeProps } from '../../src/client/RoutingModeToggle.tsx'
import { RoutingModelLabel, type RoutingLabelProps } from '../../src/client/RoutingModelLabel.tsx'
import { RoutingSettingsEntry } from '../../src/client/RoutingSettingsEntry.tsx'
import type { RoutingConfig } from '../../src/client/types.ts'
import { en, zh, type RoutingLocaleKey } from '../../src/client/locales.ts'
import './preview.css'

const query = new URLSearchParams(location.search)
const dictionary = query.get('locale') === 'en' ? en : zh
const t = (key: RoutingLocaleKey, values?: Record<string, string | number>): string => dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`))
const long = query.get('long') === '1'
const groups = [
  { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: long ? 'DeepSeek V3.2 Extremely Long Model Display Name For Wrapping' : 'DeepSeek V3.2' }, { id: 'deepseek-reasoner', name: 'DeepSeek V3.2 Thinking' }] },
  { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5.2', name: 'GPT-5.2' }] },
]
const initial: RoutingConfig = { main: { provider: 'deepseek', model: 'deepseek-chat' }, roles: { oracle: { provider: 'openai', model: 'retired/review-model', reasoningEffort: 'high' } } }

function measure(): void {
  const dialog = document.querySelector('[role="dialog"]')
  const detail = document.querySelector('[data-routing-editor] p')
  const background = dialog === null ? getComputedStyle(document.body).backgroundColor : getComputedStyle(dialog).backgroundColor
  const color = detail === null ? '' : getComputedStyle(detail).color
  const dialogStyle = dialog === null ? null : getComputedStyle(dialog)
  const done = [...document.querySelectorAll('button')].find(button => button.textContent === t('done'))
  const message = `${innerWidth}×${innerHeight}px；页面 ${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}px；弹窗 ${dialog?.scrollWidth ?? 0}/${dialog?.clientWidth ?? 0}px；完成按钮底部 ${Math.round(done?.getBoundingClientRect().bottom ?? 0)}px；正文 ${color} / ${background}；字重 ${dialogStyle?.fontWeight ?? ''}`
  window.parent.postMessage({ preview: query.get('id'), message }, location.origin)
  if (query.get('end') === '1') {
    const content = document.querySelector('[role="dialog"] > div')
    if (content !== null) content.scrollTop = content.scrollHeight
  }
}

function PreviewDialog() {
  const [config, setConfig] = useState(initial)
  const [write, setWrite] = useState<{ status: 'idle' } | { status: 'saved'; field: 'main' | 'explorer' | 'oracle' | 'fixer' | 'designer' }>({ status: 'idle' })
  const props = {
    t, useRoutingOpen: () => true,
    useRoutingSettings: (select: (value: object) => unknown) => select({ status: 'ready', value: config, writable: true, revision: 1 }),
    useRoutingCatalog: (select: (value: object) => unknown) => select({ status: 'ready', groups, failures: [], error: null }),
    useRoutingWrite: (select: (value: object) => unknown) => select(write),
    refreshCatalog: () => {}, closeConfiguration: () => {},
    saveRoute: (field: keyof RoutingConfig['roles'] | 'main', route: RoutingConfig['main']) => {
      setConfig((current) => {
        if (field === 'main') return { ...current, main: route }
        const roles = Object.fromEntries(Object.entries(current.roles).filter(([key]) => key !== field))
        if (route !== null) roles[field] = route
        return { ...current, roles }
      })
      setWrite({ status: 'saved', field })
    },
  } as RoutingDialogProps
  return <RoutingDialog {...props} />
}

if (query.get('picker') === '1') {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('button[aria-haspopup="menu"]')?.click()
  }))
}

function PreviewMenu() {
  const [enabled, setEnabled] = useState(query.get('auto') === '1')
  const session = {
    sessionId: 'preview',
    useSession: (select: (value: object) => unknown) => select({ subagent: null }),
    useSessions: (select: (value: object) => unknown) => select({ byId: {} }),
    useRoutingSettings: (select: (value: object) => unknown) => select({
      status: 'ready', writable: true, value: { ...initial, sessionModes: { preview: enabled } },
    }), t,
  }
  const mode = {
    ...session, locked: false, dismiss: () => {}, reportFailure: () => {}, openConfiguration: () => {},
    setEnabled: async (value: boolean) => { setEnabled(value); return null },
  } as RoutingModeProps
  const label = {
    ...session, provider: { id: 'deepseek', name: 'DeepSeek' },
    model: { id: 'deepseek-chat', name: 'DeepSeek V3.2', badge: { text: { en: 'Official', zh: '官方' }, tone: 'info' } },
    placement: 'trigger', selected: true, resolveText: () => dictionary === zh ? '官方' : 'Official',
  } as RoutingLabelProps
  return <div className="preview-menu">
    <h2>触发器名称插槽</h2><div className="preview-caption"><RoutingModelLabel {...label} /></div>
    <h2>模型菜单扩展行</h2><MenuSurface className="preview-menu-surface" role="menu"><RoutingModeToggle {...mode} /></MenuSurface>
    <h2>模型选项名称插槽</h2><div className="preview-caption"><RoutingModelLabel {...label} placement="option" /></div>
    <div className="preview-menu-footer"><RoutingSettingsEntry t={t} openConfiguration={() => {}} /></div>
  </div>
}

function Sprite() {
  return <svg className="preview-sprite" aria-hidden="true"><defs>{Object.entries(ICON_SYMBOLS).map(([id, markup]) => {
    const svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
    return <symbol key={id} id={id} viewBox={svg.getAttribute('viewBox') ?? '0 0 16 16'} fill={svg.getAttribute('fill') ?? 'none'} dangerouslySetInnerHTML={{ __html: svg.innerHTML }} />
  })}</defs></svg>
}

function Overview() {
  const kind = query.get('kind') ?? 'dialog'
  const width = query.get('wide') === '1' ? 760 : 390
  const height = kind === 'menu' ? 470 : query.has('short') ? 580 : 844
  return <main className="preview-grid">{['light', 'dark'].map(theme => (
    <figure className="preview-panel" key={theme}>
      <figcaption>{width}px · {theme === 'light' ? '浅色' : '深色'} · {kind === 'menu' ? '菜单插槽' : '配置弹窗'}</figcaption>
      <iframe title={`${theme} preview`} src={`?canvas=1&theme=${theme}&kind=${kind}&id=${theme}&auto=${query.get('auto') ?? '0'}&locale=${query.get('locale') ?? 'zh'}&long=${query.get('long') ?? '0'}&end=${query.get('end') ?? '0'}&picker=${query.get('picker') ?? '0'}`} width={width} height={height} />
      <output id={`metrics-${theme}`}>等待组件布局</output>
    </figure>
  ))}</main>
}

if (query.get('theme') === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
const canvas = query.has('canvas')
const mount = document.getElementById('root')
if (mount === null) throw new Error('Routing preview root is missing')
createRoot(mount).render(canvas ? <><Sprite />{query.get('kind') === 'menu' ? <PreviewMenu /> : <PreviewDialog />}</> : <Overview />)
if (canvas) {
  void document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(measure)))
} else {
  window.addEventListener('message', (event: MessageEvent<{ preview?: string; message?: string }>) => {
    if (event.origin !== location.origin || event.data.preview === undefined) return
    const output = document.getElementById(`metrics-${event.data.preview}`)
    if (output !== null) output.textContent = event.data.message ?? ''
  })
}
