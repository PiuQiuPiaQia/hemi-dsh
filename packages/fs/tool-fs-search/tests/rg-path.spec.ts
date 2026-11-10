/**
 * Failure-path tests for the lazy packaged-ripgrep resolution. The success
 * path (the real `@vscode/ripgrep` module) is exercised throughout
 * tools.spec.ts; here the module is mocked to throw at evaluation, proving a
 * missing or corrupt platform package (`--omit=optional`, partial install)
 * surfaces as a per-call `SEARCH_FAILED` — not a composition-load failure.
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { resolveRgPath, runRipgrep } from '@deepseek-ai/dsh-tool-fs-search'

// Any access to the mocked module's surface throws — the shape a missing
// platform package produces at module evaluation.
vi.mock('@vscode/ripgrep', () => new Proxy({}, {
  get() {
    throw new Error('platform package @vscode/ripgrep-win32-x64 is not installed')
  },
}))

describe('lazy packaged-ripgrep resolution', () => {
  it('fails the first search call with SEARCH_FAILED instead of failing module load', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    onTestFinished(() => ctx.fiber.dispose())
    const callId = ToolCallId('missing-platform-package')
    const exec: ToolExecution = { signal: new AbortController().signal, name: 'glob', callId, rootCallId: callId,
      token: Symbol('missing-platform-package') as ToolExecution['token'], arguments: {} }
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const search = runRipgrep(ctx, exec, 'glob', ['--files'], 1_000_000, 3_000, 64 * 1024)
    await expect(search).rejects.toMatchObject({ name: 'SearchError', code: 'SEARCH_FAILED' })
    await expect(search).rejects.toSatisfy((error: unknown) => error instanceof Error && error.cause instanceof Error
      && error.cause.message.includes('platform package'))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps failing every subsequent call (the resolution is memoized)', async () => {
    await expect(resolveRgPath()).rejects.toThrow(/platform package/)
    await expect(resolveRgPath()).rejects.toThrow(/platform package/)
  })
})
