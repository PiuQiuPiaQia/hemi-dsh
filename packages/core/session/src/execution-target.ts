/** Admission of immutable execution identities at JSON and persistence boundaries. */
import type { SessionExecutionTarget } from './types.ts'

/**
 * Recognize the complete persisted execution reference, without resolving its provider.
 * @param value - Untrusted Session metadata.
 * @returns Whether it contains exactly two bounded opaque identities.
 */
export function isSessionExecutionTarget(value: unknown): value is SessionExecutionTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'provider') || !Object.hasOwn(record, 'id')) return false
  return [record.provider, record.id].every(part => typeof part === 'string'
    && part.length > 0 && part.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(part))
}
