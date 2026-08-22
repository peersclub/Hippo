/**
 * Fetch wrapper for the portal API. Cookie auth rides same-origin through
 * the /api dev proxy; a 401 anywhere kicks back to the login screen.
 */
import { createApi } from '@hippo/ui'
import { signal } from '@preact/signals'

export { ApiError } from '@hippo/ui'

export type PortalIdentity = {
  email: string
  partnerId: string
  role: 'admin' | 'viewer'
  venueName: string
}

export const currentAdmin = signal<PortalIdentity | null>(null)

const client = createApi({
  identity: currentAdmin,
  loginPath: ['/auth/login', '/auth/claim'],
})
export const { api, get, post, patch } = client
