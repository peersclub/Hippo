import { getPool } from '@hippo/stores'
import { InMemoryScopeMemoryStore, PostgresScopeMemoryStore } from './scope-store.js'
import { buildService } from './service.js'
import { InMemoryPersonaStore, PostgresPersonaStore } from './store.js'

const PORT = Number(process.env.PORT ?? 8792)

// Postgres when DATABASE_URL is set (users_memory + memory_* tables,
// @hippo/stores migrations 004/009); in-memory otherwise.
const usePg = Boolean(process.env.DATABASE_URL)
const store = usePg ? new PostgresPersonaStore(getPool()) : new InMemoryPersonaStore()
const scopeStore = usePg ? new PostgresScopeMemoryStore(getPool()) : new InMemoryScopeMemoryStore()

const app = buildService({ store, scopeStore })
app
  .listen({ port: PORT, host: '::' })
  .then(() =>
    console.log(
      `memory on :${PORT} — opt-in persona, per-partner scoped (${process.env.DATABASE_URL ? 'postgres' : 'in-memory'})`,
    ),
  )
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
