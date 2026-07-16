/**
 * Shared pg Pool. One pool per process; created lazily so packages that only
 * use the in-memory stores never open a connection.
 */
import pg from 'pg'

let pool: pg.Pool | null = null

export function getPool(databaseUrl = process.env.DATABASE_URL): pg.Pool {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set')
  if (!pool) {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 10 })
  }
  return pool
}

export async function closePool(): Promise<void> {
  await pool?.end()
  pool = null
}
