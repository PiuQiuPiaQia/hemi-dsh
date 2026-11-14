/** Credential-store persistence: directory mutations, caps, schema validation, and the invalidation barrier. */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { MobileAccessStore, type CredentialRecords, type MobileDeviceRecord } from '../src/internal/records.ts'
import { generateTlsMaterial } from '../src/internal/tls.ts'

function device(id: string, name = `phone-${id.slice(0, 4)}`): MobileDeviceRecord {
  return { deviceId: id, name, createdAt: 1_000, secretHash: createHash('sha256').update(id, 'utf8').digest('hex') }
}

/**
 * In-memory credential operations whose next `readRecord` can be parked on an
 * explicit gate, placing an invalidation deterministically inside one read.
 */
class FakeRecords implements CredentialRecords {
  private readonly records = new Map<string, CredentialRecord>()
  private readonly gates: Array<PromiseWithResolvers<CredentialRecord | undefined>> = []

  /** Park the next read; the test resolves it with the storage value to deliver. */
  holdNextRead(): PromiseWithResolvers<CredentialRecord | undefined> {
    const gate = Promise.withResolvers<CredentialRecord | undefined>()
    this.gates.push(gate)
    return gate
  }

  /** Live storage, for simulating external edits and deletions. */
  stored(): Map<string, CredentialRecord> {
    return this.records
  }

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const gate = this.gates.shift()
    if (gate !== undefined) return gate.promise
    return this.records.get(String(key))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(String(key))
    const next = await mutate(current)
    if (next === undefined) return current
    this.records.set(String(key), next)
    return next
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(String(key))
  }
}

const DEVICE = '44444444-4444-4444-8444-444444444444'

describe('MobileAccessStore devices', () => {
  it('adds, lists, and removes devices through the credential record', async () => {
    const fake = new FakeRecords()
    const store = new MobileAccessStore(fake)
    await store.addDevice(device(DEVICE), 10)
    expect((await store.listDevices()).map(entry => entry.deviceId)).toEqual([DEVICE])
    expect(await store.removeDevice(DEVICE)).toBe(true)
    expect(await store.removeDevice(DEVICE)).toBe(false)
    expect(await store.listDevices()).toEqual([])
    const payload = JSON.stringify([...fake.stored().values()])
    expect(payload).toContain('hemi-mobile-devices')
    // The directory record persists as an empty list after the removal.
    expect(payload).not.toContain(device(DEVICE).secretHash)
  })

  it('enforces the configured device cap without writing', async () => {
    const store = new MobileAccessStore(new FakeRecords())
    await store.addDevice(device('aaaaaaaa-1111-4111-8111-111111111111'), 1)
    await expect(store.addDevice(device('bbbbbbbb-2222-4222-8222-222222222222'), 1)).rejects.toThrow('device directory is full')
    expect(await store.listDevices()).toHaveLength(1)
  })

  it('treats a record with an unexpected payload as a storage failure', async () => {
    const fake = new FakeRecords()
    fake.stored().set('hemi-mobile-access/devices', { kind: 'grant', payload: { type: 'something-else' } })
    const store = new MobileAccessStore(fake)
    await expect(store.listDevices()).rejects.toThrow('failed validation')
  })

  it('rejects damaged records instead of reading them as absent or partial', async () => {
    const fake = new FakeRecords()
    const store = new MobileAccessStore(fake)
    // A present record with no grant payload is a durable failure, not "no devices".
    fake.stored().set('hemi-mobile-access/devices', { kind: 'api-key', key: 'x' })
    await expect(store.listDevices()).rejects.toThrow('not a grant record')
    fake.stored().set('hemi-mobile-access/devices', { kind: 'grant', payload: { type: 'hemi-mobile-devices', devices: [{ deviceId: 'not-a-uuid', name: 'x', createdAt: 1, secretHash: 'f'.repeat(64) }] } })
    await expect(store.listDevices()).rejects.toThrow('failed validation')
    fake.stored().set('hemi-mobile-access/devices', { kind: 'grant', payload: { type: 'hemi-mobile-devices', devices: [{ deviceId: DEVICE, name: 'x', createdAt: 1, secretHash: 'short' }] } })
    await expect(store.listDevices()).rejects.toThrow('failed validation')
    fake.stored().set('hemi-mobile-access/tls-server', { kind: 'grant', payload: { type: 'hemi-mobile-tls', material: { keyPem: 'k', certPem: 'c', fingerprint: 'zz', sanIps: [], createdAt: 1 } } })
    await expect(store.readTls()).rejects.toThrow('failed validation')
    fake.stored().set('hemi-mobile-access/listener', { kind: 'grant', payload: { type: 'hemi-mobile-listener', host: '999.1.1.1', port: 0 } })
    await expect(store.readListener()).rejects.toThrow('failed validation')
  })
})

describe('MobileAccessStore tls and listener records', () => {
  it('round-trips generated TLS material and listener facts', async () => {
    const store = new MobileAccessStore(new FakeRecords())
    expect(await store.readTls()).toBeUndefined()
    const material = generateTlsMaterial(['192.168.1.5', '169.254.7.7'], 1_000)
    expect(material.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(material.sanIps).toEqual(['192.168.1.5', '169.254.7.7'])
    await store.writeTls(material)
    expect(await store.readTls()).toEqual(material)
    expect(await store.readListener()).toBeUndefined()
    await store.writeListener('192.168.1.5', 43211)
    expect(await store.readListener()).toEqual({ type: 'hemi-mobile-listener', host: '192.168.1.5', port: 43211 })
    store.invalidate()
    expect(await store.readTls()).toEqual(material)
  })
})

describe('MobileAccessStore invalidation barrier', () => {
  it('re-reads when an invalidation races an in-flight read instead of backfilling stale storage', async () => {
    const fake = new FakeRecords()
    const store = new MobileAccessStore(fake)
    await store.addDevice(device(DEVICE), 10)
    // An external deletion already committed and one invalidation was observed.
    fake.stored().clear()
    store.invalidate()
    const gate = fake.holdNextRead()
    const read = store.deviceById(DEVICE)
    // The read is parked inside readRecord; a second invalidation lands before
    // it resolves, so the stale completion below must neither cache nor return.
    store.invalidate()
    gate.resolve({ kind: 'grant', payload: { type: 'hemi-mobile-devices', devices: [device(DEVICE)] } })
    await expect(read).resolves.toBeUndefined()
    // The retry went back to storage: the gated read plus one live read.
    expect(await store.deviceById(DEVICE)).toBeUndefined()
  })
})
