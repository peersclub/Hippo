import { getPool } from '@hippo/stores'
import { buildService } from './service.js'
import { InMemoryPersonaStore, PostgresPersonaStore } from './store.js'

const PORT = Number(process.env.PORT ?? 8792)

// Postgres when DATABASE_URL is set (users_memory table, @hippo/stores
// migration 004); in-memory otherwise — same selection pattern as REDIS_URL.
const store = process.env.DATABASE_URL
  ? new PostgresPersonaStore(getPool())
  : new InMemoryPersonaStore()

const app = buildService({ store })
app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() =>
    console.log(
      `memory on :${PORT} — opt-in persona, per-partner scoped (${process.env.DATABASE_URL ? 'postgres' : 'in-memory'})`,
    ),
  )
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
