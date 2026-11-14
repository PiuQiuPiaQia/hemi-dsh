/** Client-only QR rendering; invitation contents never leave the browser for image generation. */
import qrcode from 'qrcode-generator'

/**
 * Encode a complete invitation with the maintained QR library.
 * @param content - Exact pairing JSON copied by the manual pairing path.
 * @returns A local image URI, or null when QR rendering fails; manual copying remains available.
 */
export function invitationQr(content: string): string | null {
  try {
    const code = qrcode(0, 'M')
    code.addData(content, 'Byte')
    code.make()
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code.createSvgTag({ scalable: true, margin: 16 }))}`
  } catch (_error: unknown) {
    // A QR failure does not invalidate the Host invitation or the manual pairing payload.
    return null
  }
}
