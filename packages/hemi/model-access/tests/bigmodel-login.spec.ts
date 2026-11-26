import { expect, it, vi } from 'vitest'
import { InMemoryCredentialStore, type OAuthCredential } from '@earendil-works/pi-ai'
import { bigModelCodingProvider, codingAuthKey } from '#bigmodel-protocol'

const callback = 'https://zcode.z.ai/api/v1/oauth/cli/callback/zai_cn'
const authorizeUrl = `https://zchat.z.ai/api/oauth/authorize?${new URLSearchParams({
  client_id: 'synthetic-client', state: 'synthetic-state', redirect_uri: callback,
})}`
const expiresAt = 4_000_000_000
const projectToken = `test.${Buffer.from(JSON.stringify({ token_use: 'project_access', api_key: 'key-id', exp: expiresAt })).toString('base64url')}.test`
const envelope = (data: object) => Response.json({ code: 0, data })

function loginHarness(url = authorizeUrl, serverTime = 1000) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope({
    flow_id: 'flow', authorize_url: url, expires_at: 1300, server_time: serverTime, poll_interval_sec: 1,
  }))
  const provider = bigModelCodingProvider(new InMemoryCredentialStore(), { fetchImpl: fetch })
  const notify = vi.fn()
  const controller = new AbortController()
  return {
    fetch, notify, controller,
    login: () => provider.auth.oauth!.login({ signal: controller.signal, notify, prompt: () => Promise.reject(new Error('Unexpected prompt')) }, {
      getDeviceId: () => 'device-id', agentName: 'Hemi',
    }),
  }
}

const ready = {
  status: 'ready', token: 'zcode-jwt', user: { user_id: 'zcode-user' },
  zai: { user_id: 'domestic-user', access_token: 'domestic-oauth-token' },
}
const linked = { customer_id: 'bigmodel-customer', access_token: 'linked-business-jwt' }

it('signs in through the provider callback and submits only the linked BigModel grant to BigModel', async () => {
  const { fetch, notify, login } = loginHarness()
  fetch.mockResolvedValueOnce(envelope({ ...ready, bigmodel: linked }))
    .mockResolvedValueOnce(envelope({ organizations: [{ organizationId: 'org', projects: [{ projectId: 'project' }] }] }))
    .mockResolvedValueOnce(envelope([{ name: 'hemi-coding-plan', apiKey: 'key-id' }]))
    .mockResolvedValueOnce(envelope({ accessToken: projectToken, expiresAt, expiresIn: 300 }))
  const grant = await login()

  const [init, poll, ...bigmodelCalls] = fetch.mock.calls
  expect(init?.[0]).toBe('https://zcode.z.ai/api/v1/oauth/cli/init')
  expect(init?.[1]?.body).toBe(JSON.stringify({ provider: 'zai_cn' }))
  expect(poll?.[0]).toBe('https://zcode.z.ai/api/v1/oauth/cli/poll/flow')
  expect(new Headers(poll?.[1]?.headers).get('authorization')).toBe(new Headers(init?.[1]?.headers).get('authorization'))
  expect(notify).toHaveBeenCalledWith({ type: 'auth_url', url: authorizeUrl })
  expect(bigmodelCalls.map(([url, options]) => [new URL(url instanceof Request ? url.url : url).origin,
    new Headers(options?.headers).get('authorization')]))
    .toEqual([['https://bigmodel.cn', linked.access_token], ['https://bigmodel.cn', linked.access_token],
      ['https://bigmodel.cn', `Bearer ${linked.access_token}`]])
  expect(grant).toMatchObject({ type: 'oauth', access: projectToken, refresh: linked.access_token, zcodeToken: ready.token })
  expect(JSON.stringify(grant)).not.toContain(ready.zai.access_token)
})

it.each([
  'https://zchat.z.ai.example.org/api/oauth/authorize?state=test',
  authorizeUrl.replace('https://zchat.z.ai', 'https://user@zchat.z.ai'),
  authorizeUrl.replace('https://zchat.z.ai/', 'https://zchat.z.ai:8443/'),
  authorizeUrl.replace(encodeURIComponent(callback), encodeURIComponent('https://example.org/callback')),
  `${authorizeUrl}&redirect_uri=${encodeURIComponent('https://example.org/callback')}`,
])('does not publish or poll an untrusted authorization URL: %s', async (url) => {
  const { fetch, notify, login } = loginHarness(url)
  await expect(login()).rejects.toMatchObject({ code: 'AUTH' })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(notify).not.toHaveBeenCalled()
})

it.each([undefined, { access_token: 'incomplete-link' }])('does not request a project token without a complete BigModel link: %j', async (bigmodel) => {
  const { fetch, login } = loginHarness()
  fetch.mockResolvedValueOnce(envelope({ ...ready, bigmodel }))
  await expect(login()).rejects.toMatchObject({ code: 'AUTH' })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('does not publish an expired flow when the server reports its clock', async () => {
  const { fetch, notify, login } = loginHarness(authorizeUrl, 1301)
  await expect(login()).rejects.toMatchObject({ code: 'AUTH', message: 'GLM 编程套餐授权已超时，请重新登录。' })
  expect(notify).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('rejects a ready response with no ZCode identity even when the BigModel link is present', async () => {
  const { fetch, login } = loginHarness()
  fetch.mockResolvedValueOnce(envelope({ ...ready, user: {}, bigmodel: linked }))
  await expect(login()).rejects.toMatchObject({ code: 'AUTH' })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('discards a ready response received after the user cancels', async () => {
  const { fetch, controller, login } = loginHarness()
  const cancelled = new DOMException('Cancelled by the user', 'AbortError')
  fetch.mockImplementationOnce(async () => {
    controller.abort(cancelled)
    return envelope({ ...ready, bigmodel: linked })
  })
  await expect(login()).rejects.toBe(cancelled)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('renews a saved pre-zai_cn grant without changing its login reference or restarting OAuth', async () => {
  const oldGrant: OAuthCredential = {
    type: 'oauth', access: 'old-pat', refresh: 'legacy-bigmodel-jwt', expires: 0,
    zcodeToken: 'legacy-zcode-jwt', deviceId: 'device-id', organizationId: 'org', projectId: 'project', apiKeyId: 'key-id',
  }
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope({ accessToken: projectToken, expiresAt, expiresIn: 300 }))
  const provider = bigModelCodingProvider(new InMemoryCredentialStore(), { fetchImpl: fetch })
  const renewed = await provider.auth.oauth!.refresh(oldGrant, new AbortController().signal)

  expect(fetch).toHaveBeenCalledTimes(1)
  const [request] = fetch.mock.calls
  expect(request?.[0]).toBe('https://bigmodel.cn/api/biz/v1/organization/org/projects/project/api_keys/key-id/access_tokens')
  expect(request?.[1]?.method).toBe('POST')
  expect(new Headers(request?.[1]?.headers).get('authorization')).toBe('Bearer legacy-bigmodel-jwt')
  expect(renewed).toMatchObject({ access: projectToken, refresh: oldGrant.refresh })
  expect(codingAuthKey(renewed)).toBe(codingAuthKey(oldGrant))
})
