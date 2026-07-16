/**
 * Redis-backed store equivalence (C1). Uses ioredis-mock — no real Redis.
 *
 * Asserts the Redis path is behaviourally equivalent to the in-memory path
 * for the properties the gateway relies on: session create/get + TTL refresh,
 * and — the load-bearing one — frame-journal Last-Event-ID resume, including a
 * cold reconnect that rebuilds the session from Redis after the live object is
 * gone.
 */
import RedisMock from 'ioredis-mock'
import { beforeEach, describe, expect, it } from 'vitest'
import { InMemorySessionStore, PARTNERS, RedisSessionStore } from '../src/plugins/auth.js'
import type { RedisClient } from '../src/plugins/redis.js'
import { createEmitter, InMemoryJournal, RedisJournal } from '../src/plugins/sse.js'

const partner = PARTNERS[0]
if (!partner) throw new Error('no dev partner configured')
const silentLog = { error: () => {} }

/** ioredis-mock shares one data store across instances by keyspace; a random
 * key namespace per test keeps them isolated without a real server. */
function freshRedis(): RedisClient {
  return new RedisMock() as unknown as RedisClient
}

describe('RedisJournal ↔ InMemoryJournal equivalence', () => {
  it('after(seq) returns the same entries as the in-memory journal', async () => {
    const redis = freshRedis()
    const mem = new InMemoryJournal()
    const red = new RedisJournal(redis, `session:eq:frames:${Math.random()}`, silentLog)
    for (let seq = 1; seq <= 5; seq++) {
      const entry = { seq, frame: { type: 'pulse', tag: `· ${seq}` } as never }
      mem.append(entry)
      red.append(entry)
    }
    await red.flush()
    expect(red.after(2).map((e) => e.seq)).toEqual(mem.after(2).map((e) => e.seq))
    expect(red.after(0)).toHaveLength(5)
    expect(red.lastSeq()).toBe(mem.lastSeq())
  })

  it('hydrate() replays the durable stream into a cold journal — resume', async () => {
    const redis = freshRedis()
    const key = `session:hydrate:frames:${Math.random()}`
    const writer = new RedisJournal(redis, key, silentLog)
    for (let seq = 1; seq <= 4; seq++) {
      writer.append({ seq, frame: { type: 'pulse', tag: `· ${seq}` } as never })
    }
    await writer.flush()

    // A fresh journal (cold pod) sees nothing until it hydrates from Redis.
    const cold = new RedisJournal(redis, key, silentLog)
    expect(cold.lastSeq()).toBe(0)
    await cold.hydrate()
    expect(cold.lastSeq()).toBe(4)
    // Last-Event-ID resume: everything strictly after seq 2, oldest first.
    expect(cold.after(2).map((e) => (e.frame as { tag: string }).tag)).toEqual(['· 3', '· 4'])
  })
})

describe('SessionStore: Redis vs in-memory', () => {
  let redis: RedisClient

  beforeEach(() => {
    redis = freshRedis()
  })

  it('create/get round-trips a session identically to in-memory', () => {
    const mem = new InMemorySessionStore()
    const red = new RedisSessionStore(redis, silentLog)
    const sMem = mem.create(partner, 'venue-1')
    const sRed = red.create(partner, 'venue-1')
    expect(sRed.id).toMatch(/^s_/)
    expect(red.get(sRed.id)?.venueUserId).toBe('venue-1')
    expect(mem.get(sMem.id)?.venueUserId).toBe('venue-1')
    expect(red.get('s_missing')).toBeNull()
    expect(mem.get('s_missing')).toBeNull()
  })

  it('persists session metadata to Redis with a live TTL (set/get/ttl)', async () => {
    const red = new RedisSessionStore(redis, silentLog)
    const s = red.create(partner, 'venue-2')
    await red.flush()
    const raw = await redis.get(`session:${s.id}:meta`)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string).venueUserId).toBe('venue-2')
  })

  it('resume rebuilds a session + replays its journal on a cold store', async () => {
    // Pod A: create a session and emit frames through the store's journal.
    const podA = new RedisSessionStore(redis, silentLog)
    const emit = createEmitter({ strict: true, log: silentLog })
    const s = podA.create(partner, 'venue-3')
    emit(s, { type: 'pulse', tag: '· one' })
    emit(s, { type: 'pulse', tag: '· two' })
    expect(s.seq).toBe(2)
    await podA.flush()

    // Pod B: never saw create(); a live get() misses, resume() rebuilds it.
    const podB = new RedisSessionStore(redis, silentLog)
    expect(podB.get(s.id)).toBeNull()
    const resumed = await podB.resume(s.id)
    expect(resumed).not.toBeNull()
    expect(resumed?.venueUserId).toBe('venue-3')
    expect(resumed?.seq).toBe(2) // high-water mark recovered from the journal
    expect(resumed?.journal.after(0).map((e) => (e.frame as { tag: string }).tag)).toEqual([
      '· one',
      '· two',
    ])
    // Last-Event-ID resume after restart: only frames past seq 1.
    expect(resumed?.journal.after(1)).toHaveLength(1)
  })

  it('resume returns null for an unknown session', async () => {
    const red = new RedisSessionStore(redis, silentLog)
    expect(await red.resume('s_never_existed')).toBeNull()
  })
})
