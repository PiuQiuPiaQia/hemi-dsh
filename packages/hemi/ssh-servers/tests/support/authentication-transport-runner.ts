/** Test-only external OpenSSH stand-in: exercises the real askpass executable, IPC, and process-group teardown. */
import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { z } from 'zod'

const scenarioSchema = z.object({
  prompts: z.array(z.object({ prompt: z.string(), hint: z.string().nullable(), expected: z.string().nullable() }).strict()),
  ready: z.boolean(),
  stderr: z.string().optional(),
  exitCode: z.number().int().min(0).max(255).optional(),
}).strict()

async function main(): Promise<void> {
  const fixturePath = process.argv[2]
  if (fixturePath === undefined) throw new Error('Missing fixture socket')
  const owner = createConnection(fixturePath)
  owner.on('error', () => { process.exitCode = 1 })
  owner.on('close', () => { process.exit(0) })
  const send = (value: object): void => { owner.write(`${JSON.stringify(value)}\n`) }
  const lines = createInterface({ input: owner })
  send({ kind: 'started', pid: process.pid, argv: process.argv.slice(3),
    authSocket: process.env.HEMI_SSH_AUTH_SOCKET, token: process.env.HEMI_SSH_AUTH_TOKEN,
    wrapper: process.env.SSH_ASKPASS, leakedEnvironment: Object.keys(process.env).filter(key => /KEY|SECRET|PASSWORD/.test(key)),
    agentSocket: process.env.SSH_AUTH_SOCK })
  const first = await lines[Symbol.asyncIterator]().next()
  if (first.done) throw new Error('Missing fixture scenario')
  const value: unknown = JSON.parse(first.value)
  const scenario = scenarioSchema.parse(value)
  for (const step of scenario.prompts) {
    const env = { ...process.env }
    if (step.hint === null) delete env.SSH_ASKPASS_PROMPT
    else env.SSH_ASKPASS_PROMPT = step.hint
    const child = spawn(process.env.SSH_ASKPASS!, [step.prompt], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('spawn', () => { send({ kind: 'worker', pid: child.pid }) })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    send({ kind: 'reply', ...result, matched: step.expected === null ? result.code === 1 : stdout === `${step.expected}\n`,
      stderrEmpty: stderr === '' })
  }
  if (scenario.stderr !== undefined) process.stderr.write(scenario.stderr)
  if (!scenario.ready) { process.exit(scenario.exitCode ?? 255) }
  const controlIndex = process.argv.indexOf('-S')
  const controlPath = process.argv[controlIndex + 1]
  const marker = process.argv.at(-1)?.match(/hemi-auth-[a-f0-9]{64}/)?.[0]
  if (controlPath === undefined || marker === undefined) throw new Error('Missing native master arguments')
  const control = createServer((socket) => { socket.destroy() })
  await new Promise<void>((resolve, reject) => { control.once('error', reject); control.listen(controlPath, resolve) })
  process.stdout.write(`${marker}\n`)
  send({ kind: 'ready', controlPath })
  process.stdin.resume()
}

void main().catch(() => { process.exit(1) })
