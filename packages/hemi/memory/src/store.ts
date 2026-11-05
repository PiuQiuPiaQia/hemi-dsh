/**
 * File-backed memory stores shared by the tools and the remote service.
 * Layout under `$DSH_HOME/hemi-memory/`: `MEMORY.md` (long-term),
 * `daily/YYYY-MM-DD.md` (daily log), `SCRATCHPAD.md` (working notes).
 */

import { mkdir, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

function memoryPath(...parts: string[]): string {
  return dshHomePath('hemi-memory', ...parts)
}

/** Target store selector shared by tools and the remote service. */
export type StoreTarget = 'long_term' | 'daily' | 'scratchpad'

/**
 * Local calendar date (YYYY-MM-DD) naming today's daily log.
 * @returns today’s local calendar date in YYYY-MM-DD form.
 */
export function todayStamp(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * Daily log path for a calendar date; empty resolves today.
 * @param date - Daily log date in YYYY-MM-DD form; omitted or empty selects today.
 * @returns the absolute validated daily log path.
 */
export function dailyPath(date: string | undefined): string {
  const stamp = date === undefined || date === '' ? todayStamp() : date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) throw new Error('Daily log date must use YYYY-MM-DD')
  const parsed = new Date(`${stamp}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== stamp) {
    throw new Error('Daily log date must be a valid calendar date')
  }
  return memoryPath('daily', `${stamp}.md`)
}

/**
 * Resolve a target selector to its store file path.
 * @param target - Long-term, daily or scratchpad store selector.
 * @param date - Daily log date in YYYY-MM-DD form; omitted or empty selects today.
 * @returns the absolute file path for the selected store.
 */
export function storePath(target: StoreTarget, date: string | undefined): string {
  if (target === 'long_term') return memoryPath('MEMORY.md')
  if (target === 'scratchpad') return memoryPath('SCRATCHPAD.md')
  return dailyPath(date)
}

/**
 * Read a store file; missing files read as empty.
 * @param path - Absolute memory store file path.
 * @returns the stored text, or empty text when the file is absent.
 */
export async function readStore(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Serialize cooperating writers and publish a complete store in one rename.
 * Returning undefined from the transform leaves the file alone.
 * @param path - Absolute memory store file path.
 * @param transform - Transform the current text; undefined leaves the file unchanged.
 * @returns whether a replacement was written.
 */
export async function updateStore(path: string, transform: (current: string) => string | undefined): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  return withFileLock(path, async () => {
    const content = transform(await readStore(path))
    if (content === undefined) return false
    await writeFileAtomic(path, content, { mode: 0o600 })
    return true
  })
}

/**
 * Append one block to a store file, keeping a separating blank line.
 * @param path - Absolute memory store file path.
 * @param content - Memory text to append or replace.
 */
export async function appendBlock(path: string, content: string): Promise<void> {
  await updateStore(path, (existing) => {
    const separator = existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
    return `${existing}${separator}${content}\n`
  })
}

/**
 * Overwrite a store file, creating the parent directory.
 * @param path - Absolute memory store file path.
 * @param content - Memory text to append or replace.
 */
export async function writeStore(path: string, content: string): Promise<void> {
  await updateStore(path, () => content)
}

/**
 * All existing store files with display names, daily logs newest first.
 * @returns existing stores with display names, with daily logs newest first.
 */
export async function allStores(): Promise<readonly { readonly label: string; readonly path: string }[]> {
  const stores = [
    { label: 'MEMORY.md (long-term)', path: storePath('long_term', undefined) },
    { label: 'SCRATCHPAD.md', path: storePath('scratchpad', undefined) },
  ]
  const daily = memoryPath('daily')
  if (existsSync(daily)) {
    for (const entry of (await readdir(daily)).sort().reverse()) {
      if (entry.endsWith('.md')) stores.push({ label: `daily/${entry}`, path: join(daily, entry) })
    }
  }
  return stores
}
