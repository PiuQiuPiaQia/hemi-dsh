/**
 * Host Remote service for the Hemi memory stores: read, write, and search
 * the markdown stores for the settings section. Persistence stays in the
 * markdown files under `$DSH_HOME/hemi-memory/`; this service is a thin
 * typed seam over {@link ./store.ts}.
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  allStores, appendBlock, readStore, storePath, writeStore,
} from './store.ts'

/** Cordis plugin name of the remote service registration. */
export const remoteName = 'hemi-memory-remote'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `hemiMemory` Remote namespace. */
    hemiMemoryRemote: HemiMemoryRemoteService
  }
}

/** Target store selector. */
type StoreTargetInput = 'long_term' | 'daily' | 'scratchpad'

function isStoreTarget(value: string): value is StoreTargetInput {
  return value === 'long_term' || value === 'daily' || value === 'scratchpad'
}

/**
 * Host service backing the generated `ctx.remote.hemiMemory` namespace.
 * @param ctx - Host context.
 */
export class HemiMemoryRemoteService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, remoteName, { namespace: 'hemiMemory' })
  }

  /**
   * Read one store's markdown content.
   * @param target - store selector.
   * @param date - daily log date (YYYY-MM-DD); defaults to today.
   * @returns the store content; empty when nothing was stored yet.
   */
  async readStore(target: string, date?: string): Promise<string> {
    if (!isStoreTarget(target)) throw new Error(`unknown memory store ${target}`)
    return readStore(storePath(target, date))
  }

  /**
   * Overwrite one store's markdown content.
   * @param target - store selector.
   * @param content - full markdown content to persist.
   * @param date - daily log date; defaults to today.
   */
  async writeStore(target: string, content: string, date?: string): Promise<void> {
    if (!isStoreTarget(target)) throw new Error(`unknown memory store ${target}`)
    await writeStore(storePath(target, date), content.endsWith('\n') ? content : `${content}\n`)
  }

  /**
   * Append one block to one store.
   * @param target - store selector.
   * @param content - markdown block to append.
   * @param date - daily log date; defaults to today.
   */
  async appendStore(target: string, content: string, date?: string): Promise<void> {
    if (!isStoreTarget(target)) throw new Error(`unknown memory store ${target}`)
    await appendBlock(storePath(target, date), content)
  }

  /**
   * Search every store for lines containing the query (case-insensitive).
   * @param query - text to find.
   * @returns matching lines with `store:line` prefixes; empty when nothing matched.
   */
  async searchStores(query: string): Promise<string> {
    const needle = query.toLowerCase()
    const hits: string[] = []
    for (const store of await allStores()) {
      const content = await readStore(store.path)
      for (const [index, line] of content.split('\n').entries()) {
        if (line.toLowerCase().includes(needle) && hits.length < 40) {
          hits.push(`${store.label}:${index + 1}: ${line.slice(0, 300)}`)
        }
      }
    }
    return hits.join('\n')
  }

  /**
   * Resolve the store file path for one target (for open-in-editor affordances).
   * @param target - store selector.
   * @param date - daily log date; defaults to today.
   * @returns the absolute store path.
   */
  storePathFor(target: string, date?: string): string {
    if (!isStoreTarget(target)) throw new Error(`unknown memory store ${target}`)
    return storePath(target, date)
  }
}

/** Mount the remote service into the Host context. @param ctx - Host context. */
export function apply(ctx: Context): void {
  ctx.plugin(HemiMemoryRemoteService)
}
