/**
 * Hemi cross-session memory plugin. Stores durable facts, dated daily
 * logs, and a working scratchpad as markdown files under
 * `$DSH_HOME/hemi-memory/`, and registers model-facing tools to read,
 * write, search, and forget entries. Files stay user-editable; every
 * tool is line-oriented so the model never rewrites unrelated content.
 * @module @deepseek-ai/dsh-hemi-memory
 */

import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Cordis plugin name. */
export const name = 'hemi-memory'
/** Services used by the tools. */
export const inject = ['tools']

/** Memory root under the harness home; each store is one markdown file. */
const MEMORY_DIR = dshHomePath('hemi-memory')
const LONG_TERM_PATH = join(MEMORY_DIR, 'MEMORY.md')
const SCRATCHPAD_PATH = join(MEMORY_DIR, 'SCRATCHPAD.md')
const DAILY_DIR = join(MEMORY_DIR, 'daily')

/** Local calendar date (YYYY-MM-DD) naming today's daily log. */
function todayStamp(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** Daily log path for a calendar date; empty resolves today. */
function dailyPath(date: string | undefined): string {
  return join(DAILY_DIR, `${date === undefined || date === '' ? todayStamp() : date}.md`)
}

/** Read a store file; missing files read as empty. */
async function readStore(path: string): Promise<string> {
  if (!existsSync(path)) return ''
  return readFile(path, 'utf8')
}

/** Append one block to a store file, keeping a separating blank line. */
async function appendBlock(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const existing = await readStore(path)
  const separator = existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  await appendFile(path, `${separator}${content}\n`)
}

/** Overwrite a store file, creating the parent directory. */
async function writeStore(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

/** Target store selector shared by the tools. */
type StoreTarget = 'long_term' | 'daily' | 'scratchpad'

/** Resolve a target selector to its store file path. */
function storePath(target: StoreTarget, date: string | undefined): string {
  if (target === 'long_term') return LONG_TERM_PATH
  if (target === 'scratchpad') return SCRATCHPAD_PATH
  return dailyPath(date)
}

/** All existing store files with display names. */
async function allStores(): Promise<readonly { readonly label: string; readonly path: string }[]> {
  const stores = [
    { label: 'MEMORY.md (long-term)', path: LONG_TERM_PATH },
    { label: 'SCRATCHPAD.md', path: SCRATCHPAD_PATH },
  ]
  if (existsSync(DAILY_DIR)) {
    for (const entry of (await readdir(DAILY_DIR)).sort().reverse()) {
      if (entry.endsWith('.md')) stores.push({ label: `daily/${entry}`, path: join(DAILY_DIR, entry) })
    }
  }
  return stores
}

/** Cordis plugin body: register the memory tools. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: [
      'Persist information across sessions into the Hemi memory stores. Targets:',
      '`long_term` — MEMORY.md, curated durable facts, decisions, and preferences (survives everything; keep entries short and factual);',
      '`daily` — today\'s dated log `daily/YYYY-MM-DD.md`, for progress notes and day-scoped context (always appends);',
      '`scratchpad` — SCRATCHPAD.md, volatile working context and checklists.',
      'Use `append` (default) to add a block; use `overwrite` only to rewrite long_term or scratchpad wholesale after reading them.',
    ].join(' '),
    parameters: {
      target: { type: 'string', description: 'Memory store to write.', required: true },
      content: { type: 'string', description: 'Markdown content to store. Keep long_term entries atomic (one fact per block); prefix daily blocks with a `<!-- HH:MM -->` timestamp.', required: true },
      mode: { type: 'string', description: '`append` (default) adds a block; `overwrite` replaces the whole store (long_term and scratchpad only).' },
      date: { type: 'string', description: 'Daily log date as YYYY-MM-DD; defaults to today. Ignored for other targets.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', required: true, description: 'Store file written.' }, action: { type: 'string', required: true, description: 'What was done.' } },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.action}: ${value.path}` }],
    },
    async execute(args) {
      const target = args.target as StoreTarget
      if (target !== 'long_term' && target !== 'daily' && target !== 'scratchpad') {
        throw new Error(`memory_write target must be long_term, daily, or scratchpad; got ${args.target}`)
      }
      const path = storePath(target, args.date as string | undefined)
      if (args.mode === 'overwrite') {
        if (target === 'daily') throw new Error('daily logs only append; omit mode or use append')
        await writeStore(path, args.content.endsWith('\n') ? args.content : `${args.content}\n`)
        return { path, action: `overwrote ${target} store` }
      }
      await appendBlock(path, args.content)
      return { path, action: `appended to ${target} store` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: 'Read one Hemi memory store: `long_term` (MEMORY.md), `scratchpad` (SCRATCHPAD.md), or a `daily` log (defaults to today; pass date for older days). Use before overwriting a store, or to recall previously saved context.',
    parameters: {
      target: { type: 'string', description: 'Memory store to read.', required: true },
      date: { type: 'string', description: 'Daily log date as YYYY-MM-DD; defaults to today. Ignored for other targets.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', required: true, description: 'Store file read.' }, content: { type: 'string', required: true, description: 'Store content; empty when nothing was stored yet.' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.content === '' ? `(empty store: ${value.path})` : value.content }],
    },
    async execute(args) {
      const target = args.target as StoreTarget
      if (target !== 'long_term' && target !== 'daily' && target !== 'scratchpad') {
        throw new Error(`memory_read target must be long_term, daily, or scratchpad; got ${args.target}`)
      }
      const path = storePath(target, args.date as string | undefined)
      return { path, content: await readStore(path) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Keyword search across every Hemi memory store (long-term, scratchpad, and all daily logs). Case-insensitive substring match per line; returns matching lines with their store and line number. Use it to recall where something was saved before reading the surrounding content with memory_read.',
    parameters: {
      query: { type: 'string', description: 'Case-insensitive text to find.', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { hits: { type: 'string', required: true, description: 'Matching lines with `store:line` prefixes; empty when nothing matched.' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.hits === '' ? '(no memory matches)' : value.hits }],
    },
    async execute(args) {
      const query = args.query.toLowerCase()
      const hits: string[] = []
      for (const store of await allStores()) {
        const lines = (await readStore(store.path)).split('\n')
        for (const [index, line] of lines.entries()) {
          if (line.toLowerCase().includes(query) && hits.length < 40) {
            hits.push(`${store.label}:${index + 1}: ${line.slice(0, 300)}`)
          }
        }
      }
      return { hits: hits.join('\n') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Remove entries from a Hemi memory store. Deletes every line containing the match text (case-insensitive) and collapses the blank gaps left behind. Use it when the user corrects or retracts a stored fact; confirm what was removed in the result.',
    parameters: {
      target: { type: 'string', description: 'Memory store to clean: long_term, daily, or scratchpad.', required: true },
      match: { type: 'string', description: 'Case-insensitive substring identifying the entries to remove.', required: true },
      date: { type: 'string', description: 'Daily log date as YYYY-MM-DD; defaults to today. Ignored for other targets.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { removed: { type: 'string', required: true, description: 'How many lines were removed and from which store.' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.removed }],
    },
    async execute(args) {
      const target = args.target as StoreTarget
      if (target !== 'long_term' && target !== 'daily' && target !== 'scratchpad') {
        throw new Error(`memory_forget target must be long_term, daily, or scratchpad; got ${args.target}`)
      }
      const path = storePath(target, args.date as string | undefined)
      const content = await readStore(path)
      if (content === '') return { removed: `store ${path} is already empty` }
      const match = args.match.toLowerCase()
      const kept: string[] = []
      let removed = 0
      for (const line of content.split('\n')) {
        if (line.toLowerCase().includes(match)) removed += 1
        else kept.push(line)
      }
      const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n')
      await writeStore(path, cleaned === '' ? '' : `${cleaned}${cleaned.endsWith('\n') ? '' : '\n'}`)
      return { removed: `removed ${removed} line(s) from ${path}` }
    },
  }))
}
