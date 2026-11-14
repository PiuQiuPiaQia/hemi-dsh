/**
 * Credential-store persistence for mobile access: approved device records
 * (secret hashes only), the generated TLS material, and the last bound
 * listener facts. All durable state lives in DSH credential grant records
 * under this plugin's scope, so an external edit or revocation drops the
 * in-memory cache and the next read re-reads storage (fail closed).
 */

import { z } from 'zod'
import { credentialKey, type CredentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { MobileTlsMaterial } from './tls.ts'

/** Owning plugin name; the credential seam requires the registered plugin's scope. */
export const MOBILE_ACCESS_CREDENTIAL_SCOPE = 'hemi-mobile-access'

/** Record ids inside the scope; the seam requires lowercase hyphenated identifiers. */
const DEVICES_RECORD_ID = 'devices'
const TLS_RECORD_ID = 'tls-server'
const LISTENER_RECORD_ID = 'listener'

/** Durable-boundary grammar: a stored record either parses whole or fails loudly. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

const deviceRecordSchema = z.object({
  deviceId: z.string().regex(UUID_PATTERN),
  name: z.string().min(1).max(64),
  createdAt: z.number().nonnegative(),
  secretHash: z.string().regex(SHA256_HEX_PATTERN),
})

const devicesPayloadSchema = z.object({
  type: z.literal('hemi-mobile-devices'),
  devices: z.array(deviceRecordSchema),
})

const tlsPayloadSchema = z.object({
  type: z.literal('hemi-mobile-tls'),
  material: z.object({
    keyPem: z.string().min(1),
    certPem: z.string().min(1),
    fingerprint: z.string().regex(SHA256_HEX_PATTERN),
    sanIps: z.array(z.string().regex(IPV4_PATTERN)).min(1),
    createdAt: z.number().nonnegative(),
  }),
})

const listenerPayloadSchema = z.object({
  type: z.literal('hemi-mobile-listener'),
  host: z.string().regex(IPV4_PATTERN),
  port: z.number().int().min(1).max(65535),
})

/** One approved phone as persisted; `secretHash` is the only secret-derived value stored. */
export interface MobileDeviceRecord {
  readonly deviceId: string
  readonly name: string
  readonly createdAt: number
  readonly secretHash: string
}

/** Grant payload of the device-directory record. */
export interface MobileDevicesPayload {
  readonly type: 'hemi-mobile-devices'
  readonly devices: readonly MobileDeviceRecord[]
}

/** Grant payload of the TLS record. */
export interface MobileTlsPayload {
  readonly type: 'hemi-mobile-tls'
  readonly material: MobileTlsMaterial
}

/** Grant payload of the listener record. */
export interface MobileListenerPayload {
  readonly type: 'hemi-mobile-listener'
  readonly host: string
  readonly port: number
}

/** Credential operations the store needs; the service supplies the live provider. */
export type CredentialRecords = Pick<CredentialProvider, 'readRecord' | 'modifyRecord' | 'deleteRecord'>

const DEVICES_KEY: CredentialKey = credentialKey(MOBILE_ACCESS_CREDENTIAL_SCOPE, DEVICES_RECORD_ID)
const TLS_KEY: CredentialKey = credentialKey(MOBILE_ACCESS_CREDENTIAL_SCOPE, TLS_RECORD_ID)
const LISTENER_KEY: CredentialKey = credentialKey(MOBILE_ACCESS_CREDENTIAL_SCOPE, LISTENER_RECORD_ID)

/** Unparsed stored record as the seam hands it over. */
interface StoredRecord {
  readonly kind?: unknown
  readonly payload?: unknown
}

/**
 * Validate one stored record against its payload schema. A present record that
 * is not a grant carrying a complete, well-typed payload is a durable-boundary
 * failure: it throws (and surfaces as `credentials-unavailable`) instead of
 * reading as absent, so a damaged store never silently authorizes or empties
 * the directory.
 * @param record - stored record value.
 * @param schema - payload schema for the record's slot.
 * @param where - record slot name for the diagnostic.
 * @returns the validated payload, or undefined only when no record exists.
 */
function decodeStored<T>(record: unknown, schema: z.ZodType<T>, where: string): T | undefined {
  if (record === undefined) return undefined
  if (record === null || typeof record !== 'object') {
    throw new Error(`hemi-mobile-access: credential record ${where} is not a grant record`)
  }
  const stored = record as StoredRecord
  if (stored.kind !== 'grant' || stored.payload === undefined) {
    throw new Error(`hemi-mobile-access: credential record ${where} is not a grant record`)
  }
  const parsed = schema.safeParse(stored.payload)
  if (!parsed.success) {
    throw new Error(`hemi-mobile-access: credential record ${where} failed validation: ${JSON.stringify(parsed.error.issues)}`)
  }
  return parsed.data
}

/**
 * Read-modify-write cache over the three credential records. Every read goes
 * through the cache and every write refreshes it; {@link invalidate} bumps a
 * generation counter, and every read and write completes its generation check
 * and its cache assignment in one synchronous continuation, so a record
 * deleted or replaced underneath never keeps authorizing through the cache.
 */
export class MobileAccessStore {
  private devices: readonly MobileDeviceRecord[] | undefined
  private tls: MobileTlsMaterial | undefined
  private listener: MobileListenerPayload | undefined
  private devicesWrites: Promise<unknown> = Promise.resolve()
  private generation = 0

  /**
   * @param records - live credential provider operations.
   */
  constructor(private readonly records: CredentialRecords) {}

  /** Drop every cached record; reads that began earlier re-read storage. */
  invalidate(): void {
    this.generation += 1
    this.devices = undefined
    this.tls = undefined
    this.listener = undefined
  }

  /** Current invalidation epoch; callers fence cross-await admissions against it. */
  get version(): number {
    return this.generation
  }

  /**
   * Cache reads behind methods: a direct field read stays narrowed across an
   * `await`, which would let the type checker drop the re-check a concurrent
   * invalidation or write can still make true.
   */
  private cachedDevices(): readonly MobileDeviceRecord[] | undefined {
    return this.devices
  }

  private cachedTls(): MobileTlsMaterial | undefined {
    return this.tls
  }

  private cachedListener(): MobileListenerPayload | undefined {
    return this.listener
  }

  /**
   * Current approved devices, reading storage on the first access after
   * construction or {@link invalidate}.
   * @returns devices in approval order.
   */
  async listDevices(): Promise<readonly MobileDeviceRecord[]> {
    if (this.devices !== undefined) return this.devices
    for (;;) {
      const observed = this.generation
      const record = await this.records.readRecord(DEVICES_KEY)
      // The check and the cache fill below run in the same continuation as the
      // resumption above; an invalidation landing in between any two of these
      // statements either bumps the generation (re-read) or clears the cache
      // after the fill (next read re-reads). No two-step await gap exists.
      if (observed !== this.generation) continue
      const cached = this.cachedDevices()
      if (cached !== undefined) return cached
      this.devices = decodeStored(record, devicesPayloadSchema, 'devices')?.devices ?? []
      return this.devices
    }
  }

  /**
   * Look up one device by id without exposing why a miss happened.
   * @param deviceId - device identity from the presented credential.
   * @returns the record when the device is currently approved.
   */
  async deviceById(deviceId: string): Promise<MobileDeviceRecord | undefined> {
    return (await this.listDevices()).find(device => device.deviceId === deviceId)
  }

  /**
   * Append one approved device under an exclusive record write.
   * @param record - the new device with its secret hash.
   * @param maxDevices - configured directory cap.
   * @throws when the directory is full; nothing is written.
   */
  async addDevice(record: MobileDeviceRecord, maxDevices: number): Promise<void> {
    await this.serialize(async () => {
      const observed = this.generation
      const after = await this.records.modifyRecord(DEVICES_KEY, (current) => {
        const devices = decodeStored(current, devicesPayloadSchema, 'devices')?.devices ?? []
        if (devices.some(device => device.deviceId === record.deviceId)) return Promise.resolve(undefined)
        if (devices.length >= maxDevices) throw new Error(`device directory is full (${String(maxDevices)})`)
        const payload: MobileDevicesPayload = { type: 'hemi-mobile-devices', devices: [...devices, record] }
        return Promise.resolve({ kind: 'grant', payload })
      })
      this.commitDevicesCache(observed, after)
    })
  }

  /**
   * Remove one device; removing an absent id is a no-op.
   * @param deviceId - device identity to withdraw.
   * @returns true when a record was removed.
   */
  async removeDevice(deviceId: string): Promise<boolean> {
    let removed = false
    await this.serialize(async () => {
      const observed = this.generation
      const after = await this.records.modifyRecord(DEVICES_KEY, (current) => {
        const devices = decodeStored(current, devicesPayloadSchema, 'devices')?.devices ?? []
        if (!devices.some(device => device.deviceId === deviceId)) return Promise.resolve(undefined)
        removed = true
        const payload: MobileDevicesPayload = {
          type: 'hemi-mobile-devices',
          devices: devices.filter(device => device.deviceId !== deviceId),
        }
        return Promise.resolve({ kind: 'grant', payload })
      })
      this.commitDevicesCache(observed, after)
    })
    return removed
  }

  /**
   * Fill the devices cache from a write result in the same continuation as the
   * write; an invalidation that landed during the write leaves the cache empty
   * for the next read instead of backfilling the pre-write view.
   */
  private commitDevicesCache(observed: number, after: unknown): void {
    if (observed !== this.generation) return
    const devices = decodeStored(after, devicesPayloadSchema, 'devices')?.devices
    if (devices !== undefined) this.devices = devices
  }

  /**
   * Read the persisted TLS material.
   * @returns the material, or undefined before the first generation.
   */
  async readTls(): Promise<MobileTlsMaterial | undefined> {
    if (this.tls !== undefined) return this.tls
    for (;;) {
      const observed = this.generation
      const record = await this.records.readRecord(TLS_KEY)
      if (observed !== this.generation) continue
      const cached = this.cachedTls()
      if (cached !== undefined) return cached
      this.tls = decodeStored(record, tlsPayloadSchema, 'tls-server')?.material
      return this.tls
    }
  }

  /**
   * Persist the TLS material for reuse across restarts.
   * @param material - generated certificate and key.
   */
  async writeTls(material: MobileTlsMaterial): Promise<void> {
    const observed = this.generation
    const payload: MobileTlsPayload = { type: 'hemi-mobile-tls', material }
    await this.records.modifyRecord(TLS_KEY, () => Promise.resolve({ kind: 'grant', payload }))
    if (observed === this.generation) this.tls = material
  }

  /**
   * Read the last successfully bound listener facts.
   * @returns the persisted host and port, or undefined before the first start.
   */
  async readListener(): Promise<MobileListenerPayload | undefined> {
    if (this.listener !== undefined) return this.listener
    for (;;) {
      const observed = this.generation
      const record = await this.records.readRecord(LISTENER_KEY)
      if (observed !== this.generation) continue
      const cached = this.cachedListener()
      if (cached !== undefined) return cached
      this.listener = decodeStored(record, listenerPayloadSchema, 'listener')
      return this.listener
    }
  }

  /**
   * Persist the listener facts of one successful bind.
   * @param host - bound IPv4 address.
   * @param port - bound port.
   */
  async writeListener(host: string, port: number): Promise<void> {
    const observed = this.generation
    const payload: MobileListenerPayload = { type: 'hemi-mobile-listener', host, port }
    await this.records.modifyRecord(LISTENER_KEY, () => Promise.resolve({ kind: 'grant', payload }))
    if (observed === this.generation) this.listener = payload
  }

  /** Serialize device-directory mutations against each other. */
  private serialize(operation: () => Promise<unknown>): Promise<unknown> {
    const done = this.devicesWrites.then(operation, operation)
    this.devicesWrites = done.catch(() => undefined)
    return done
  }
}
