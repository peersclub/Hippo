import { AssetworksVenueAdapter } from './assetworks-venue.js'
import { KoinbxVenueAdapter } from './koinbx-venue.js'
import { buildService } from './service.js'
import { SimVenueAdapter } from './sim-venue.js'
import type { VenueAdapter } from './types.js'

const PORT = Number(process.env.PORT ?? 8793)

/**
 * VENUE selects the adapter behind the Canonical Trading Interface.
 * `sim` (default) is the dev/demo venue; `koinbx` is the Phase 3 pilot
 * (KOINBX_API_KEY / KOINBX_SECRET / KOINBX_BASE_URL); `assetworks` is the
 * full-fidelity test host (ASSETWORKS_API_KEY / _SECRET / _BASE_URL) — a real
 * HTTP venue we control end to end, so the parasite integration runs against
 * genuine rails (HMAC, poll reconciler, both confirm surfaces) not a sim timer.
 */
function selectAdapter(): { adapter: VenueAdapter; label: string } {
  if (process.env.VENUE === 'assetworks') {
    const { ASSETWORKS_API_KEY, ASSETWORKS_SECRET, ASSETWORKS_BASE_URL } = process.env
    if (!ASSETWORKS_API_KEY || !ASSETWORKS_SECRET || !ASSETWORKS_BASE_URL)
      throw new Error(
        'VENUE=assetworks requires ASSETWORKS_API_KEY, ASSETWORKS_SECRET and ASSETWORKS_BASE_URL',
      )
    return {
      adapter: new AssetworksVenueAdapter({
        apiKey: ASSETWORKS_API_KEY,
        secret: ASSETWORKS_SECRET,
        baseUrl: ASSETWORKS_BASE_URL,
        confirmSurface: (process.env.ASSETWORKS_CONFIRM_SURFACE as never) ?? 'api',
      }),
      label: 'Assetworks Exchange test-host adapter',
    }
  }
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
