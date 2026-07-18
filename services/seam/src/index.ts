import { KoinbxVenueAdapter } from './koinbx-venue.js'
import { buildService } from './service.js'
import { SimVenueAdapter } from './sim-venue.js'
import type { VenueAdapter } from './types.js'

const PORT = Number(process.env.PORT ?? 8793)

/**
 * VENUE selects the adapter behind the Canonical Trading Interface.
 * `sim` (default) is the dev/demo venue; `koinbx` is the Phase 3 pilot,
 * which needs KOINBX_API_KEY / KOINBX_SECRET / KOINBX_BASE_URL.
 */
function selectAdapter(): { adapter: VenueAdapter; label: string } {
  if (process.env.VENUE === 'koinbx') {
    const { KOINBX_API_KEY, KOINBX_SECRET, KOINBX_BASE_URL } = process.env
    if (!KOINBX_API_KEY || !KOINBX_SECRET || !KOINBX_BASE_URL)
      throw new Error('VENUE=koinbx requires KOINBX_API_KEY, KOINBX_SECRET and KOINBX_BASE_URL')
    return {
      adapter: new KoinbxVenueAdapter({
        apiKey: KOINBX_API_KEY,
        secret: KOINBX_SECRET,
        baseUrl: KOINBX_BASE_URL,
        confirmSurface: (process.env.KOINBX_CONFIRM_SURFACE as never) ?? 'api',
      }),
      label: 'KoinBX pilot adapter',
    }
  }
  return { adapter: new SimVenueAdapter(), label: 'sim venue adapter' }
}

const { adapter, label } = selectAdapter()
const app = buildService(adapter)
app
  .listen({ port: PORT, host: '::' })
  .then(() => console.log(`seam on :${PORT} — canonical trading interface, ${label}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
