/**
 * File-backed memory stores shared by the tools and the remote service.
 * Layout under `$DSH_HOME/hemi-memory/`: `MEMORY.md` (long-term),
 * `daily/YYYY-MM-DD.md` (daily log), `SCRATCHPAD.md` (working notes).
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Memory root under the harness home. */
export const MEMORY_DIR = dshHomePath('hemi-memory')
/** Long-term store path. */
export const LONG_TERM_PATH = join(MEMORY_DIR, 'MEMORY.md')
/** Scratchpad store path. */
export const SCRATCHPAD_PATH = join(MEMORY_DIR, 'SCRATCHPAD.md')
/** Daily log directory. */
export const DAILY_DIR = join(MEMORY_DIR, 'daily')

/** Target store selector shared by tools and the remote service. */
export type StoreTarget = 'long_term' | 'daily' | 'scratchpad'

/** Local calendar date (YYYY-MM-DD) naming today's daily log. */
export function todayStamp(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** Daily log path for a calendar date; empty resolves today. */
export function dailyPath(date: string | undefined): string {
  return join(DAILY_DIR, `${date === undefined || date === '' ? todayStamp() : date}.md`)
}

/** Resolve a target selector to its store file path. */
export function storePath(target: StoreTarget, date: string | undefined): string {
  if (target === 'long_term') return LONG_TERM_PATH
  if (target === 'scratchpad') return SCRATCHPAD_PATH
  return dailyPath(date)
}

/** Read a store file; missing files read as empty. */
export async function readStore(path: string): Promise<string> {
  if (!existsSync(path)) return ''
  return readFile(path, 'utf8')
}

/** Append one block to a store file, keeping a separating blank line. */
export async function appendBlock(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const existing = await readStore(path)
  const separator = existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  await appendFile(path, `${separator}${content}\n`)
}

/** Overwrite a store file, creating the parent directory. */
export async function writeStore(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

/** All existing store files with display names, daily logs newest first. */
export async function allStores(): Promise<readonly { readonly label: string; readonly path: string }[]> {
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
