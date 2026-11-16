/** VVCode keeps account usage separate from one unified directory read per authorization. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VvcodeDirectory, VvcodeModelSelection } from '@deepseek-ai/dsh-hemi-model-access/types'
import { SubscriptionCard, type SubscriptionCardProps } from './SubscriptionCard.tsx'
import { useVvcodeUsage } from './VvcodeUsage.ts'
import type { ModelAccessActions } from './types.ts'

/** @param props - Account facts and native operations. @returns one account card with all authorized groups. */
export function VvcodeSubscription(props: SubscriptionCardProps) {
  const { row, actions, modelsChanged, attempt } = props
  const usage = useVvcodeUsage(props)
  const identity = `${row.connected}/${row.vvcode?.expiresAt ?? ''}/${attempt?.id ?? ''}/${attempt?.phase ?? ''}`
  // Written during render so continuations resumed from a superseded authorization see the current one.
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const [snapshot, setSnapshot] = useState<{ identity: string; directory: VvcodeDirectory | null }>({ identity, directory: null })
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [mutationBusy, setMutationBusy] = useState(false)
  const cycle = useRef<{ identity: string; request: AbortController; done: Promise<boolean> } | null>(null)
  const writes = useRef(new Map<symbol, AbortController>())
  const queue = useRef(Promise.resolve())
  const connected = row.connected && attempt?.phase !== 'pending'
  const read = useCallback((options?: { fresh?: boolean }): Promise<boolean> => {
    // A superseded authorization or a signed-out card never owns a read cycle.
    if (currentIdentity.current !== identity || !connected) {
      if (cycle.current === null) setLoading(false)
      return Promise.resolve(false)
    }
    const current = cycle.current
    // Concurrent readers of one authorization reuse the in-flight cycle; only a post-write or
    // superseding read starts a new one, and the stale cycle is aborted instead of reissued.
    if (current !== null && current.identity === identity && options?.fresh !== true) return current.done
    current?.request.abort()
    const request = new AbortController()
    setLoading(true)
    setFailed(false)
    const done = (async (): Promise<boolean> => {
      try {
        const directory = await actions.vvcodeDirectory(request.signal)
        if (request.signal.aborted) return false
        setSnapshot({ identity, directory })
        return true
      } catch (_error: unknown) {
        if (!request.signal.aborted) setFailed(true)
        return false
      } finally {
        // Only the settled cycle releases the busy state; a superseding cycle owns it next.
        if (cycle.current?.request === request) {
          cycle.current = null
          setLoading(false)
        }
      }
    })()
    cycle.current = { identity, request, done }
    return done
  }, [actions, connected, identity])
  useEffect(() => {
    void read()
    const pending = writes.current
    return () => {
      cycle.current?.request.abort()
      cycle.current = null
      for (const request of pending.values()) request.abort()
      pending.clear()
      setMutationBusy(false)
    }
  }, [read])

  /** Refresh the directory only after the write settles, so saved selections are never read stale. */
  async function saved(): Promise<void> {
    await modelsChanged()
    if (!await read({ fresh: true })) throw new Error('VVCode directory refresh failed')
  }

  const enqueue = useCallback((request: AbortController, run: () => Promise<void>): Promise<void> => {
    const next = queue.current.then(async () => {
      request.signal.throwIfAborted()
      await run()
    })
    queue.current = next.catch((_error: unknown) => {
      // The originating write reports its own failure; later writes still receive their turn.
    })
    return next
  }, [])

  const publishWrites = useCallback((): void => {
    setMutationBusy(writes.current.size > 0)
  }, [])

  const mutate = useCallback(async (run: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    const id = Symbol()
    const request = new AbortController()
    writes.current.set(id, request)
    publishWrites()
    try {
      await enqueue(request, () => run(request.signal))
      request.signal.throwIfAborted()
    } finally {
      writes.current.delete(id)
      if (!request.signal.aborted) publishWrites()
    }
  }, [enqueue, publishWrites])
  const groupActions = useMemo<ModelAccessActions>(() => ({ ...actions,
    saveModelOptions: (provider, model, options, revision) => mutate(
      () => actions.saveModelOptions(provider, model, options, revision)),
  }), [actions, mutate])

  async function save(selections: VvcodeModelSelection[], caller: AbortSignal): Promise<void> {
    await mutate(async (signal) => {
      const combined = AbortSignal.any([caller, signal])
      combined.throwIfAborted()
      await actions.saveVvcodeModels(selections, combined)
      combined.throwIfAborted()
      await saved()
    })
  }

  return <SubscriptionCard {...props} {...usage} actions={groupActions} vvcodeGroups={{
    directory: snapshot.identity === identity ? snapshot.directory : null,
    loading, failed, mutationBusy,
    ensure: () => {
      if (snapshot.identity !== identity || snapshot.directory === null || failed) void read()
    },
    refresh: () => { void read() },
    saved, save,
  }} />
}
