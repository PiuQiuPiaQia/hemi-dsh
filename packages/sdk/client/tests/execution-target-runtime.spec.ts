/** Both persisted target metadata and refusal reach the public TypeScript SDK through the shipped profile. */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { DeepSeekHarness, JsonRpcResponseError } from '../src/index.ts'

const fixture = fileURLToPath(new URL('./fixtures/execution-target.mjs', import.meta.url))
const expected = fileURLToPath(new URL('./expected/execution-target.json', import.meta.url))

async function logsUnder(root: string): Promise<Map<string, Buffer>> {
  const logs = new Map<string, Buffer>()
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /^session.*\.jsonl$/u.test(entry.name)) {
      const path = join(entry.parentPath, entry.name)
      logs.set(path, await readFile(path))
    }
  }
  return logs
}

it('preserves a target through ordinary fork and refuses cold SDK resume without Host activation', async () => {
  const allocated = await mkdtemp(join(tmpdir(), 'dsh-sdk-target-'))
  const root = await realpath(allocated)
  const workspace = join(root, 'host-workspace'), home = join(root, 'home'), logs = join(root, 'sessions')
  const reportPath = join(root, 'headers.json'), trace = join(root, 'agents.jsonl'), patch = join(root, 'target.patch.yml')
  const marker = join(workspace, 'host-marker.txt')
  let harness: DeepSeekHarness | undefined
  try {
    await mkdir(workspace)
    await writeFile(marker, 'Host data must remain untouched\n')
    await writeFile(patch, `- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(logs)}\n    compression: none\n- insert:\n    - id: sdk-execution-target-fixture\n      name: ${JSON.stringify(fixture)}\n`)
    const options = { profile: 'sdk', cwd: workspace, processCwd: workspace, dshHome: home, patches: [patch],
      initializeTimeoutMs: 60_000, requestTimeoutMs: 30_000, shutdownTimeoutMs: 30_000,
      env: { ...process.env, DEEPSEEK_API_KEY: 'keyless-execution-target', DSH_TELEMETRY_DISABLED: '1', DSH_SDK_TARGET_CWD: workspace,
        DSH_SDK_TARGET_REPORT: reportPath, DSH_SDK_TARGET_TRACE: trace },
    }
    harness = new DeepSeekHarness(options)
    await harness.start()
    await harness.close()
    const before = await logsUnder(logs)
    expect(before.size).toBe(2)
    harness = new DeepSeekHarness(options)
    await harness.start()
    const refusals: { sessionId: string; code: number | undefined; message: string }[] = []
    for (const sessionId of ['sdk-target-parent', 'sdk-target-fork']) {
      try {
        await harness.resumeSession(sessionId)
        throw new Error('An unavailable target was accepted')
      } catch (error: unknown) {
        if (!(error instanceof JsonRpcResponseError)) throw error
        refusals.push({ sessionId, code: error.code, message: error.message })
      }
    }
    await harness.close()
    const after = await logsUnder(logs)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [path, content] of before) expect(after.get(path)).toEqual(content)
    const headers: unknown = JSON.parse(await readFile(reportPath, 'utf8'))
    const actual = { headers, refusals, agentsCreated: (await readFile(trace, 'utf8')).split('\n').filter(Boolean).length,
      logsUnchanged: true, hostMarkerUnchanged: await readFile(marker, 'utf8') === 'Host data must remain untouched\n' }
    const oracle: unknown = JSON.parse(await readFile(expected, 'utf8'))
    expect(actual).toEqual(oracle)
  } finally {
    await harness?.close()
    if (await realpath(allocated) !== root) throw new Error('SDK fixture root was replaced')
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
