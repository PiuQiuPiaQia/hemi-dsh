/**
 * Minimal WebDAV client for backup targets (tested against Nutstore).
 * Covers exactly the operations the backup orchestrator needs: directory
 * creation, upload, listing, deletion, download, and a connection probe.
 *
 * @module @deepseek-ai/dsh-hemi-backup/webdav
 */

import fs, { createWriteStream, openAsBlob } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Typed WebDAV failure with a stable code for the UI. */
export class WebdavError extends Error {
  override name = 'WebdavError'
  /**
   * @param code - stable failure code.
   * @param message - human-readable failure description.
   */
  constructor(readonly code: 'AUTH_FAILED' | 'NOT_FOUND' | 'REQUEST_FAILED', message: string) {
    super(message)
  }
}

/** One remote child entry from listing. */
export interface WebdavEntry {
  /** Entry name. */
  readonly name: string
  /** Whether the entry is a directory collection. */
  readonly isDir: boolean
}

/** Client construction inputs. */
export interface WebdavClientOptions {
  /** Server base URL, for example `https://dav.jianguoyun.com/dav/`. */
  readonly baseUrl: string
  /** Account name. */
  readonly username: string
  /** Application password; never the account login password. */
  readonly password: string
  /** Minimal logger with a warn channel; optional. */
  readonly log?: { warn(message: string): void }
}

/** Remote-facing WebDAV operations used by the backup orchestrator. */
export interface WebdavClient {
  /** Create a remote directory; existing directories are success. */
  ensureDir(remotePath: string): Promise<void>
  /** Upload one local file by streaming. */
  uploadFile(remotePath: string, localAbs: string): Promise<void>
  /** List one directory's direct children. */
  listDir(remotePath: string): Promise<readonly WebdavEntry[]>
  /** Delete one remote file or collection recursively. */
  deleteFile(remotePath: string): Promise<void>
  /** Download one remote file to a local path. */
  downloadToFile(remotePath: string, localAbs: string): Promise<void>
  /** Probe credentials and reachability. */
  testConnection(): Promise<{ ok: true } | { ok: false; code: WebdavError['code']; message: string }>
}

/** Decode `xml:locale`-agnostic multistatus listing bodies. */
function parseMultistatus(body: string, dirPath: string): WebdavEntry[] {
  const entries: WebdavEntry[] = []
  for (const response of body.matchAll(/<d:response[^>]*>([\s\S]*?)<\/d:response>|<D:response[^>]*>([\s\S]*?)<\/D:response>/g)) {
    const block = response[1] ?? response[2] ?? ''
    const href = (block.match(/<d:href>([\s\S]*?)<\/d:href>|<D:href>([\s\S]*?)<\/D:href>/)?.[1] ?? block.match(/<d:href>([\s\S]*?)<\/d:href>|<D:href>([\s\S]*?)<\/D:href>/)?.[2] ?? '').trim()
    if (href === '') continue
    const name = decodeURIComponent(href.replace(/\/$/, '').split('/').filter(part => part !== '').at(-1) ?? '')
    if (name === '') continue
    const dirName = dirPath.replace(/\/$/, '').split('/').filter(part => part !== '').at(-1) ?? ''
    if (name === dirName) continue
    const isDir = /<d:collection\/>|<D:collection\/>/.test(block) || href.endsWith('/')
    entries.push({ name, isDir })
  }
  return entries
}

/**
 * Create a WebDAV client over `fetch`.
 * @param options - server, credentials, and optional logger.
 * @returns the operation set bound to the given credentials.
 */
export function createWebdavClient(options: WebdavClientOptions): WebdavClient {
  const base = options.baseUrl.replace(/\/+$/, '')
  const headers = () => ({ Authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}` })
  const url = (remotePath: string): string => `${base}/${remotePath.replace(/^\/+/, '')}`
  const failure = async (response: Response, action: string): Promise<never> => {
    if (response.status === 401) throw new WebdavError('AUTH_FAILED', `${action}: wrong account or application password`)
    if (response.status === 404) throw new WebdavError('NOT_FOUND', `${action}: remote path not found`)
    throw new WebdavError('REQUEST_FAILED', `${action}: HTTP ${response.status} ${await response.text().catch(() => '')}`.trim())
  }
  return {
    async ensureDir(remotePath: string): Promise<void> {
      // Build every missing ancestor; existing collections answer 405.
      const segments = remotePath.split('/').filter(part => part !== '')
      let current = ''
      for (const segment of segments) {
        current = current === '' ? segment : `${current}/${segment}`
        const response = await fetch(url(current), { method: 'MKCOL', headers: headers() })
        if (!response.ok && response.status !== 405) await failure(response, `MKCOL ${current}`)
      }
    },
    async uploadFile(remotePath: string, localAbs: string): Promise<void> {
      // openAsBlob streams the file from disk instead of buffering a whole volume.
      const body = await openAsBlob(localAbs)
      const response = await fetch(url(remotePath), { method: 'PUT', headers: headers(), body })
      if (!response.ok) await failure(response, `PUT ${remotePath}`)
    },
    async listDir(remotePath: string): Promise<readonly WebdavEntry[]> {
      const response = await fetch(url(remotePath), {
        method: 'PROPFIND',
        headers: { ...headers(), Depth: '1' },
      })
      if (!response.ok) await failure(response, `PROPFIND ${remotePath}`)
      return parseMultistatus(await response.text(), remotePath)
    },
    async deleteFile(remotePath: string): Promise<void> {
      const response = await fetch(url(remotePath), { method: 'DELETE', headers: headers() })
      if (!response.ok && response.status !== 404) await failure(response, `DELETE ${remotePath}`)
    },
    async downloadToFile(remotePath: string, localAbs: string): Promise<void> {
      const response = await fetch(url(remotePath), { headers: headers() })
      if (!response.ok) await failure(response, `GET ${remotePath}`)
      if (response.body === null) throw new WebdavError('REQUEST_FAILED', `GET ${remotePath}: empty response body`)
      fs.mkdirSync(path.dirname(localAbs), { recursive: true })
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(localAbs))
    },
    async testConnection(): Promise<{ ok: true } | { ok: false; code: WebdavError['code']; message: string }> {
      try {
        const response = await fetch(`${base}/`, { method: 'PROPFIND', headers: { ...headers(), Depth: '0' } })
        if (response.ok) return { ok: true }
        if (response.status === 401) return { ok: false, code: 'AUTH_FAILED', message: 'wrong account or application password' }
        if (response.status === 404) return { ok: false, code: 'NOT_FOUND', message: 'server address or directory not found' }
        return { ok: false, code: 'REQUEST_FAILED', message: `HTTP ${response.status}` }
      } catch (error) {
        return { ok: false, code: 'REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
