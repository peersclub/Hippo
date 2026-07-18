/**
 * Portal service entry. Stores: Postgres when DATABASE_URL is set, in-memory
 * otherwise (dev). In dev (no Postgres) a claimable invite can be minted via
 * the operator panel; in-memory mode is per-process, so run the portal and
 * admin against the compose Postgres to exercise the full invite→claim flow
 * across services.
 */
import { randomBytes } from 'node:crypto'
import {
  getPool,
  InMemoryAuditStore,
  InMemoryPartnerAdminStore,
  InMemoryPartnerStore,
  InMemoryPlanStore,
  InMemoryUserStore,
  PostgresAuditStore,
  PostgresMauStore,
  PostgresPartnerAdminStore,
  PostgresPartnerStore,
  PostgresPlanStore,
  PostgresUserStore,
} from '@hippo/stores'
import { buildPortalService } from './service.js'

const PORT = Number(process.env.PORT ?? 8795)
const usePg = Boolean(process.env.DATABASE_URL)
const pool = usePg ? getPool() : null

const partners = pool ? new PostgresPartnerStore(pool) : new InMemoryPartnerStore()
const plans = pool ? new PostgresPlanStore(pool) : new InMemoryPlanStore(async () => false)
const users = pool ? new PostgresUserStore(pool) : new InMemoryUserStore()
const partnerAdmins = pool ? new PostgresPartnerAdminStore(pool) : new InMemoryPartnerAdminStore()
const audit = pool ? new PostgresAuditStore(pool) : new InMemoryAuditStore()

// Session-signing secret: env in production; ephemeral per boot in dev.
// MUST differ from ADMIN_JWT_SECRET — the token universes never intersect.
const jwtSecret = process.env.PORTAL_JWT_SECRET ?? randomBytes(32).toString('hex')

const app = buildPortalService({
  partners,
  plans,
  users,
  partnerAdmins,
  audit,
  jwtSecret,
  ...(pool ? { mauStore: new PostgresMauStore(pool) } : {}),
})

app
  .listen({ port: PORT, host: '::' })
  .then(() =>
    console.log(
      `portal on :${PORT} — partner self-serve (own data, integration, plan) (${usePg ? 'postgres' : 'in-memory'})`,
    ),
  )
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
