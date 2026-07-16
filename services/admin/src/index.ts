/**
 * Admin service entry. Stores: Postgres when DATABASE_URL is set, in-memory
 * otherwise (dev). First operator bootstraps from ADMIN_BOOTSTRAP_EMAIL /
 * ADMIN_BOOTSTRAP_PASSWORD when the operator table is empty — the password
 * is hashed immediately and never logged.
 */
import { randomBytes } from 'node:crypto'
import {
  getPool,
  InMemoryAuditStore,
  InMemoryOperatorStore,
  InMemoryPartnerStore,
  InMemoryPlanStore,
  InMemoryUserStore,
  PostgresAuditStore,
  PostgresMauStore,
  PostgresOperatorStore,
  PostgresPartnerStore,
  PostgresPlanStore,
  PostgresUserStore,
} from '@hippo/stores'
import { hashPassword } from './opauth.js'
import { buildAdminService } from './service.js'

const PORT = Number(process.env.PORT ?? 8794)
const usePg = Boolean(process.env.DATABASE_URL)
const pool = usePg ? getPool() : null

const partners = pool ? new PostgresPartnerStore(pool) : new InMemoryPartnerStore()
// In-memory plan delete-safety checks the partner registry; Postgres does
// this internally against the partners table.
const plans = pool
  ? new PostgresPlanStore(pool)
  : new InMemoryPlanStore(async (planId) =>
      (await partners.list()).some((p) => p.planId === planId),
    )
const users = pool ? new PostgresUserStore(pool) : new InMemoryUserStore()
const operators = pool ? new PostgresOperatorStore(pool) : new InMemoryOperatorStore()
const audit = pool ? new PostgresAuditStore(pool) : new InMemoryAuditStore()

// Session-signing secret: env in production; ephemeral per boot in dev
// (operator sessions simply die on restart — honest and safe).
const jwtSecret = process.env.ADMIN_JWT_SECRET ?? randomBytes(32).toString('hex')

// Bootstrap the first operator when the table is empty.
if ((await operators.count()) === 0) {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD
  if (email && password) {
    await operators.create({ email, passwordHash: hashPassword(password), role: 'owner' })
    console.log(`bootstrapped owner operator ${email}`)
  } else {
    console.warn(
      'no operators exist and ADMIN_BOOTSTRAP_EMAIL/ADMIN_BOOTSTRAP_PASSWORD are not set — nobody can sign in',
    )
  }
}

const app = buildAdminService({
  partners,
  plans,
  users,
  operators,
  audit,
  jwtSecret,
  // Durable MAU counts (quota alerts survive gateway restarts).
  ...(pool ? { mauStore: new PostgresMauStore(pool) } : {}),
})
app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() =>
    console.log(
      `admin on :${PORT} — operators, partners, plans, users (${usePg ? 'postgres' : 'in-memory'})`,
    ),
  )
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
