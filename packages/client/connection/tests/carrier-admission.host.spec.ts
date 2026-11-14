/** Additional authenticated listeners keep the same Host request-admission lifecycle. */
import { Context } from '@deepseek-ai/cordis'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserAuth } from '../src/browser-auth.ts'
import { HostConnectionService } from '../src/rpc-host.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('authenticated carrier admission', () => {
  it('runs the Host admission waterfall before dispatch and preserves an admitted Peer', async () => {
    const ctx = new Context()
    roots.push(ctx)
    const provider = ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth) })
    await provider.await()
    const connection = ctx.connection
    const peer = connection.createPeer({ principal: { kind: 'owner' } })
    const served = vi.fn(async (request: Request, caller: typeof peer) => {
      expect(caller).toBe(peer)
      return new Response(await request.text())
    })
    let locked = true
    const removeLock = ctx.on('connection/request', async (_request, response, next) => {
      if (locked) { response.writeHead(423); response.end('locked'); return }
      await next()
    })
    const server = createServer((request, response) => {
      void connection.serveHttp(request, response, {
        requestBodyMode: () => 'buffered', fetch: served,
      }, peer, 1024).catch(() => { response.destroy() })
    })
    const release = ctx.effect(() => async () => {
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture has no TCP listener')
    const url = `http://127.0.0.1:${String(address.port)}/api/fixture`
    const refused = await fetch(url, { method: 'POST', body: 'not admitted' })
    expect(refused.status).toBe(423)
    expect(await refused.text()).toBe('locked')
    expect(served).not.toHaveBeenCalled()
    locked = false
    const accepted = await fetch(url, { method: 'POST', body: 'same Host' })
    expect(accepted.status).toBe(200)
    expect(await accepted.text()).toBe('same Host')
    expect(served).toHaveBeenCalledOnce()
    removeLock()
    await release()
  })
})
