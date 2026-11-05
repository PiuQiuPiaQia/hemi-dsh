/** Host entry for the Hemi memory settings page. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { readStore, storePath, updateStore, type StoreTarget } from './store.ts'

export type { StoreTarget } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the memory settings endpoints. */
    hemiMemory: HemiMemoryService
  }
}

/** The editor loads a revision with the content and sends it back when saving. */
export interface MemorySnapshot {
  content: string
  revision: string
}

function revisionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Read and edit the same Markdown files used by the memory tools. */
export default class HemiMemoryService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'hemiMemory', { namespace: 'hemiMemory' })
  }

  /**
   * Read one memory file. A missing file is an empty document.
   * @param target - memory store.
   * @param date - YYYY-MM-DD for a daily log.
   * @returns document content and the revision required to save it.
   */
  @Remote
  async readStore(target: StoreTarget, date?: string): Promise<MemorySnapshot> {
    const content = await readStore(storePath(target, date))
    return { content, revision: revisionOf(content) }
  }

  /**
   * Replace a memory file only if its content still matches the loaded revision.
   * @param target - memory store.
   * @param content - replacement Markdown.
   * @param revision - revision from readStore or the last successful save.
   * @param date - YYYY-MM-DD for a daily log.
   * @returns new revision, or null when the file changed before saving.
   */
  @Remote
  async saveStore(target: StoreTarget, content: string, revision: string, date?: string): Promise<string | null> {
    const saved = await updateStore(storePath(target, date), current =>
      revisionOf(current) === revision ? content : undefined)
    return saved ? revisionOf(content) : null
  }
}
