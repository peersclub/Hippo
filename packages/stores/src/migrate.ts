/**
 * Minimal migration runner — applies migrations/NNN_*.sql in filename order,
 * records each in schema_migrations, skips already-applied. No ORM, no
 * migration framework: numbered SQL files are the whole story.
 *
 * CLI: DATABASE_URL=postgres://... pnpm --filter @hippo/stores migrate
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPool } from './db.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export async function migrate(databaseUrl = process.env.DATABASE_URL): Promise<string[]> {
  const pool = getPool(databaseUrl)
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL)',
  )
  const applied = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string),
  )
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

  const ran: string[] = []
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [
        file,
        Date.now(),
      ])
      await client.query('COMMIT')
      ran.push(file)
    } catch (err) {
      await client.query('ROLLBACK')
      throw new Error(`migration ${file} failed: ${String(err)}`)
    } finally {
      client.release()
    }
  }
  return ran
}

// CLI entry: `tsx src/migrate.ts`
if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  migrate()
    .then((ran) => {
      console.log(ran.length ? `applied: ${ran.join(', ')}` : 'up to date')
      return import('./db.js').then((m) => m.closePool())
    })
    .catch((err) => {
      console.error(String(err))
      process.exit(1)
    })
}
