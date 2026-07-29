/**
 * Host-venue durable state — one JSONB row per venue instance (migration
 * 014). The venue keeps its whole book of record (orders, positions,
 * wallets, handoffs, admin config, id counter) in memory for speed and
 * writes a debounced snapshot here; on boot it restores the row, so a
 * container restart no longer erases positions. `state` is opaque to this
 * package — the venue owns the snapshot shape and its versioning.
 */
import type pg from 'pg'

export interface HostVenueStateStore {
  /** The last saved snapshot, or null if this venue has never saved one. */
  load(venueId: string): Promise<unknown | null>
  /** Upsert the snapshot; the venue passes its own clock for updated_at. */
  save(venueId: string, state: unknown, now: number): Promise<void>
}

export class InMemoryHostVenueStateStore implements HostVenueStateStore {
  private readonly rows = new Map<string, { state: unknown; updatedAt: number }>()

  async load(venueId: string): Promise<unknown | null> {
    const row = this.rows.get(venueId)
    return row === undefined ? null : row.state
  }

  async save(venueId: string, state: unknown, now: number): Promise<void> {
    // Round-trip through JSON so the saved row shares no references with the
    // live store — the same isolation Postgres gives for free.
    this.rows.set(venueId, { state: JSON.parse(JSON.stringify(state)), updatedAt: now })
  }
}

export class PostgresHostVenueStateStore implements HostVenueStateStore {
  constructor(private readonly pool: pg.Pool) {}

  async load(venueId: string): Promise<unknown | null> {
    const res = await this.pool.query('SELECT state FROM host_venue_state WHERE venue_id = $1', [
      venueId,
    ])
    return res.rows[0]?.state ?? null
  }

  async save(venueId: string, state: unknown, now: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO host_venue_state (venue_id, state, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (venue_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
      [venueId, JSON.stringify(state), now],
    )
  }
}
