/**
 * Self-signed TLS material for the mobile listener: generated in-process with
 * SANs for the current LAN addresses, `serverAuth` extended key usage, and a
 * SHA-256 signature; persisted through the credential store by the service.
 */

import { createHash, X509Certificate } from 'node:crypto'
import { generate as generateSelfSigned } from 'selfsigned'

/** Certificate and key as generated once, then reused across restarts. */
export interface MobileTlsMaterial {
  /** Private key PEM the listener signs handshakes with. */
  readonly keyPem: string
  /** Leaf certificate PEM, self-signed. */
  readonly certPem: string
  /** SHA-256 of the leaf DER, lowercase hex, no colons. */
  readonly fingerprint: string
  /** IPv4 SANs the certificate covers. */
  readonly sanIps: readonly string[]
  /** Generation time in epoch milliseconds. */
  readonly createdAt: number
}

/** Forge extension spellings `selfsigned` forwards verbatim; the typings accept `any[]`. */
interface SubjectAltNameExtension {
  readonly name: 'subjectAltName'
  readonly altNames: readonly { readonly type: 7; readonly ip: string }[]
}

interface ExtKeyUsageExtension {
  readonly name: 'extKeyUsage'
  readonly serverAuth: true
}

/**
 * Generate one self-signed server certificate covering `ips` as IP SANs.
 * @param ips - concrete IPv4 addresses of this Host, including the bind address.
 * @param createdAt - generation time in epoch milliseconds recorded with the material.
 * @returns the PEM pair with its fingerprint and SAN set.
 */
export function generateTlsMaterial(ips: readonly string[], createdAt: number): MobileTlsMaterial {
  const extensions: (SubjectAltNameExtension | ExtKeyUsageExtension)[] = [
    { name: 'subjectAltName', altNames: ips.map(ip => ({ type: 7, ip })) },
    { name: 'extKeyUsage', serverAuth: true },
  ]
  const pems = generateSelfSigned([{ name: 'commonName', value: 'Hemi mobile access' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions,
  })
  return {
    keyPem: pems.private,
    certPem: pems.cert,
    fingerprint: fingerprintOfCertPem(pems.cert),
    sanIps: [...ips],
    createdAt,
  }
}

/**
 * Fingerprint one certificate PEM as the pairing protocol publishes it.
 * @param certPem - leaf certificate PEM.
 * @returns SHA-256 of the DER encoding, lowercase hex, no colons.
 * @throws when the PEM does not decode as one certificate.
 */
export function fingerprintOfCertPem(certPem: string): string {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex')
}
