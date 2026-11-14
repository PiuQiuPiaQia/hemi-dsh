import { expect, it } from 'vitest'
import { invitationQr } from '../src/client/qr.ts'
import { invitation } from './fixtures.client.ts'

it('renders the exact invitation entirely as a local QR image without a third-party image request', () => {
  const image = invitationQr(JSON.stringify(invitation))
  expect(image?.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
  const svg = decodeURIComponent(image!.split(',')[1]!)
  expect(svg).toContain('<svg')
  expect(svg).not.toContain('<image')
  expect(svg).not.toContain(invitation.origin)
})

it('keeps QR rendering failure separate from the manual invitation content', () => {
  expect(invitationQr('x'.repeat(5000))).toBeNull()
})
