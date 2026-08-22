/**
 * Fetch wrapper for the admin API. Cookie auth rides same-origin through the
 * /api dev proxy; a 401 anywhere kicks back to the login screen.
 */
import { createApi } from '@hippo/ui'
import { signal } from '@preact/signals'

export { ApiError } from '@hippo/ui'

export type Operator = { email: string; role: 'owner' | 'operator' }

export const currentOperator = signal<Operator | null>(null)

const client = createApi({ identity: currentOperator })
export const { api, get, post, put, patch, del } = client
