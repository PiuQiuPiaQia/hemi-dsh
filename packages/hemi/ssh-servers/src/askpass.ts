/** Private OpenSSH askpass executable. Only its owner socket receives prompts; stdout carries one native reply. */
import { createConnection } from 'node:net'
import {
  MAX_AUTHENTICATION_FRAME_BYTES, parseAskpassRequest, parseAskpassResponse,
} from './authentication-protocol.ts'

async function main(): Promise<void> {
  const path = process.env.HEMI_SSH_AUTH_SOCKET
  const token = process.env.HEMI_SSH_AUTH_TOKEN
  const timeoutMs = Number(process.env.HEMI_SSH_AUTH_TIMEOUT_MS)
  const request = parseAskpassRequest({
    token, pid: process.pid, prompt: process.argv[2], hint: process.env.SSH_ASKPASS_PROMPT ?? null,
  })
  if (path === undefined || !path.startsWith('/') || request === undefined
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    process.exitCode = 1
    return
  }
  delete process.env.HEMI_SSH_AUTH_TOKEN
  const frame = Buffer.from(`${JSON.stringify(request)}\n`)
  if (frame.length > MAX_AUTHENTICATION_FRAME_BYTES) { process.exitCode = 1; return }
  const socket = createConnection({ path })
  const socketClosed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  let incoming = Buffer.alloc(0)
  let answered = false
  const response = await new Promise<string | null>((resolve) => {
    const fail = (): void => { socket.destroy(); resolve(null) }
    const deadline = setTimeout(fail, timeoutMs)
    socket.once('close', () => { clearTimeout(deadline); if (!answered) resolve(null) })
    socket.once('error', fail)
    socket.once('connect', () => { socket.write(frame, () => { frame.fill(0) }) })
    socket.on('data', (chunk: Buffer) => {
      if (answered || incoming.length + chunk.length > MAX_AUTHENTICATION_FRAME_BYTES) { fail(); return }
      incoming = Buffer.concat([incoming, chunk])
      const newline = incoming.indexOf(10)
      if (newline === -1) return
      if (newline !== incoming.length - 1) { fail(); return }
      let parsed: unknown
      try { parsed = JSON.parse(incoming.subarray(0, newline).toString('utf8')) }
      catch (error: unknown) { void error; fail(); return }
      const reply = parseAskpassResponse(parsed)
      incoming.fill(0)
      incoming = Buffer.alloc(0)
      if (reply === undefined) { fail(); return }
      answered = true
      clearTimeout(deadline)
      socket.destroy()
      resolve(reply.answer)
    })
  })
  await socketClosed
  incoming.fill(0)
  frame.fill(0)
  if (response === null) { process.exitCode = 1; return }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${response}\n`, (error) => { if (error) reject(error); else resolve() })
  })
}

// This private executable must never print exception details, prompts, or answers to stderr.
void main().catch((error: unknown) => { void error; process.exitCode = 1 })
