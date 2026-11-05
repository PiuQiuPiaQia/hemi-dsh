import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(join(repo, 'apps/desktop/package.json'))

it.skipIf(process.platform !== 'darwin')(
  'reconciles a lost create response and resumes cleanup through the Electron bridge',
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'hemi-native-new-api-'))
    onTestFinished(() => rm(scratch, { recursive: true, force: true }))
    const patch = join(scratch, 'native.patch.yml')
    await writeFile(patch, '- id: hemi-model-access\n  disabled: false\n')
    const scaffold = await launchWebScaffold({ developerTools: false, extraOverlayPath: patch })
    onTestFinished(() => scaffold.close())
    let token: Record<string, unknown> | undefined
    let creates = 0
    let probes = 0
    let deletes = 0
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const json = (value: unknown, status = 200): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      const envelope = (value: unknown): void => { json({ success: true, data: value }) }
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end(`<button onclick="fetch('/api/user/self',{headers:{Authorization:'Bearer fixture-browser-grant',
          'New-Api-User':'42'}}).then(r=>{if(r.ok)document.body.dataset.signedIn='yes'})">Sign in</button>`)
        return
      }
      if (url.pathname === '/api/status') { envelope({ system_name: 'Fixture New API' }); return }
      if (url.pathname.startsWith('/api/') && request.headers.authorization !== 'Bearer fixture-browser-grant') {
        json({ success: false }, 401)
        return
      }
      switch (url.pathname) {
        case '/api/user/self':
          envelope({ id: 42, username: 'fixture-user' })
          break
        case '/api/user/self/groups':
          envelope({ team: { desc: 'Fixture team', ratio: 1 } })
          break
        case '/api/pricing':
          envelope([{ model_name: 'fixture-model', enable_groups: ['team'], supported_endpoint_types: ['openai'] }])
          break
        case '/api/token/search':
          envelope({ items: token === undefined ? [] : [token] })
          break
        case '/api/token/':
          if (request.method === 'POST') {
            creates += 1
            let body = ''
            request.setEncoding('utf8')
            request.on('data', (chunk: string) => { body += chunk })
            request.on('end', () => {
              token = {
                ...JSON.parse(body) as Record<string, unknown>,
                id: 12 + creates, user_id: 42, created_time: Math.floor(Date.now() / 1000),
              }
              // A real server may commit the write and then lose its response.
              json({ success: false }, 500)
            })
          } else envelope({ items: token === undefined ? [] : [token], total: token === undefined ? 0 : 1 })
          break
        case '/api/token/13/key':
        case '/api/token/14/key':
          envelope({ key: 'fixture-model-key' })
          break
        case '/api/token/14':
          expect(request.method).toBe('DELETE')
          deletes += 1
          if (deletes === 1) json({ success: false }, 500)
          else envelope(null)
          break
        case '/v1/models':
          json({ data: [{ id: 'fixture-model' }] })
          break
        case '/v1/chat/completions':
          if (request.headers.authorization !== 'Bearer sk-fixture-model-key') { json({}, 401); break }
          probes += 1
          if (creates === 2) { json({}, 403); break }
          json({ choices: [{ message: { content: 'OK' } }] })
          break
        default:
          json({}, 404)
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => {
      server.closeAllConnections()
      server.close()
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('New API fixture failed to bind')
    const electron: unknown = require('electron')
    if (typeof electron !== 'string') throw new Error('Electron is unavailable')
    const fixture = join(repo, 'apps/desktop/tests/fixtures/hemi-new-api-electron.mjs')
    const login = await fetch(scaffold.authenticatedUrl, { redirect: 'manual' })
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
    expect(login.status).toBe(303)
    expect(cookie).toBeTruthy()
    const launcher = join(scratch, 'launcher')
    await mkdir(launcher)
    await writeFile(join(launcher, 'package.json'), '{"main":"main.cjs"}')
    await writeFile(join(launcher, 'main.cjs'), `import(${JSON.stringify(pathToFileURL(fixture).href)}).catch(error => {
      console.error(error.message)
      require('electron').app.exit(1)
    })`)
    const child = await promisify(execFile)(electron, [launcher, '--use-mock-keychain'], {
      cwd: repo,
      timeout: 45_000,
      env: { ...process.env, HEMI_TEST_DESKTOP_DATA: scratch,
        HEMI_TEST_NEW_API_SITE: `http://127.0.0.1:${address.port}`,
        HEMI_TEST_HOST_URL: scaffold.baseUrl, HEMI_TEST_HOST_COOKIE: cookie },
    }).catch((error: unknown) => {
      const stderr = (error as { stderr?: string }).stderr
      throw new Error(stderr?.trim() || 'Native Electron import fixture did not complete', { cause: error })
    })
    expect(child.stdout).toContain('HEMI_NEW_API_RESULT=')
    expect(creates).toBe(2)
    expect(probes).toBe(2)
    expect(deletes).toBe(2)
    expect(token).toMatchObject({ group: 'team', remain_quota: 2_500_000, unlimited_quota: false })
    const routes = scaffold.ctx.llm.listProviders().filter(provider => provider.id.startsWith('mpi-'))
    expect(routes).toHaveLength(1)
    const route = routes[0]
    if (route === undefined) throw new Error('The imported provider is missing')
    expect((await scaffold.ctx.llm.listModels(route.id)).map(model => model.id)).toEqual(['fixture-model'])
    const settings = await readFile(join(scaffold.harnessHome, 'profiles/scaffold/cordis.patch.yml'), 'utf8')
    expect(settings).not.toMatch(/fixture-browser-grant|fixture-model-key/)
  },
  60_000,
)
