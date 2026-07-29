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
import {
  createSession,
  sendTurn,
  stubIntel,
  submitDraft,
  TEST_INTERNAL_TOKEN,
  testApp,
  waitForJournal,
} from './helpers.js'

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

describe('durable ticket routing (Tier-2): venue events survive a gateway restart', () => {
  const buyIntent = () =>
    stubIntel({
      intent: () => ({
        intent: 'action',
        confidence: 0.9,
        language: 'en',
        order: { side: 'buy', size: '0.05', instrument: 'BTC/USDT', orderType: 'market' },
      }),
    })

  /** A gateway over a Redis-backed session store sharing `redis`. Building a
   * second one over the same client simulates a restart: fresh app, fresh
   * orchestrator (empty ticketSessions), same durable Redis state. */
  async function redisGateway(redis: RedisClient) {
    const store = new RedisSessionStore(redis, silentLog)
    const gw = await testApp({ sessions: store, intel: buyIntent() })
    return { ...gw, store }
  }

  /** Drive prepare (draft → ticket) + confirm on a fresh session. */
  async function prepareAndConfirm(gw: Awaited<ReturnType<typeof redisGateway>>) {
    const session = await createSession(gw.app, gw.store)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    const { ticket } = await submitDraft(gw.app, session)
    await sendTurn(gw.app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'confirm_handoff',
    })
    await waitForJournal(session, (t) => t.includes('lifecycle'))
    return { session, ticket }
  }

  function lifecyclePhases(session: { journal: { after(seq: number): { frame: unknown }[] } }) {
    return session.journal
      .after(0)
      .map((e) => e.frame as { type: string; phase?: string })
      .filter((f) => f.type === 'lifecycle')
      .map((f) => f.phase)
  }

  it('THE HEADLINE: a venue FILL after a restart is routed and journaled, not dropped', async () => {
    const redis = freshRedis()

    // Pod A: prepare + confirm an order, then "crash" (close the app).
    const gwA = await redisGateway(redis)
    const { session, ticket } = await prepareAndConfirm(gwA)
    await gwA.store.flush()
    await gwA.app.close()

    // Pod B: a brand-new gateway + orchestrator over the same Redis. Its
    // in-process ticketSessions map is empty — pre-fix this fill dropped.
    const gwB = await redisGateway(redis)
    const res = await gwB.app.inject({
      method: 'POST',
      url: '/internal/venue-events',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
      payload: {
        ticketId: ticket.ticketId,
        phase: 'filled',
        statusLine: 'FILLED',
        venueOrderId: 'SIM-9000',
      },
    })
    expect(res.json()).toEqual({ ok: true, routed: true })

    // The resumed session's journal carries the full lifecycle — the
    // pre-restart awaiting_confirm AND the post-restart fill — so a
    // reconnecting SSE client replays both.
    const resumed = gwB.store.get(session.id)
    expect(resumed).not.toBeNull()
    expect(lifecyclePhases(resumed as NonNullable<typeof resumed>)).toEqual([
      'awaiting_confirm',
      'filled',
    ])
    // Side is enriched from the rehydrated session.tickets map.
    const fill = resumed?.journal
      .after(0)
      .map((e) => e.frame as { type: string; phase?: string; side?: string })
      .find((f) => f.type === 'lifecycle' && f.phase === 'filled')
    expect(fill?.side).toBe('buy')

    // Terminal phase tears the durable state down: ticket key gone, and the
    // rehydrated tickets map is empty again.
    await gwB.store.flush()
    expect(await redis.get(`session:ticket:${ticket.ticketId}`)).toBeNull()
    expect(resumed?.tickets.size).toBe(0)
    await gwB.app.close()
  })

  it('ticket key lifecycle: written at prepare with a TTL, deleted at the terminal phase', async () => {
    const redis = freshRedis()
    const gw = await redisGateway(redis)
    const session = await createSession(gw.app, gw.store)
    await sendTurn(gw.app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    const { ticket } = await submitDraft(gw.app, session)
    await gw.store.flush()

    const key = `session:ticket:${ticket.ticketId}`
    expect(await redis.get(key)).toBe(session.id)
    // TTL ≈ the backstop window (default 10 min) + slack — never unbounded.
    const pttl = await (redis as unknown as { pttl(k: string): Promise<number> }).pttl(key)
    expect(pttl).toBeGreaterThan(0)
    expect(pttl).toBeLessThanOrEqual(10 * 60_000 + 30_000)

    // Confirm, then the venue's terminal event → the key is gone.
    await sendTurn(gw.app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'confirm_handoff',
    })
    await waitForJournal(session, (t) => t.includes('lifecycle'))
    await gw.app.inject({
      method: 'POST',
      url: '/internal/venue-events',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
      payload: { ticketId: ticket.ticketId, phase: 'filled', statusLine: 'FILLED' },
    })
    await gw.store.flush()
    expect(await redis.get(key)).toBeNull()
    await gw.app.close()
  })

  it('session.tickets round-trips through the meta snapshot, confirm state included', async () => {
    const redis = freshRedis()
    const gwA = await redisGateway(redis)
    const { session, ticket } = await prepareAndConfirm(gwA)
    await gwA.store.flush()
    await gwA.app.close()

    const podB = new RedisSessionStore(redis, silentLog)
    const resumed = await podB.resume(session.id)
    expect(resumed).not.toBeNull()
    const quote = resumed?.tickets.get(ticket.ticketId)
    expect(quote).toMatchObject({
      side: 'buy',
      instrument: 'BTC/USDT',
      sizeDisplay: '0.05',
      confirmed: true,
    })
  })

  it('a ticket cancelled before restart stays dead: the straggler event is audit-only', async () => {
    const redis = freshRedis()
    const gwA = await redisGateway(redis)
    const session = await createSession(gwA.app, gwA.store)
    await sendTurn(gwA.app, session.id, { kind: 'user_text', text: 'buy 0.05 btc' })
    const { ticket } = await submitDraft(gwA.app, session)
    // Pre-confirm cancel: nothing reached the venue; the durable key is dropped.
    await sendTurn(gwA.app, session.id, {
      kind: 'ticket_action',
      ticketId: ticket.ticketId,
      action: 'cancel',
    })
    await waitForJournal(session, (t) => t.includes('lifecycle'))
    await gwA.store.flush()
    await gwA.app.close()

    const gwB = await redisGateway(redis)
    const res = await gwB.app.inject({
      method: 'POST',
      url: '/internal/venue-events',
      headers: { 'x-hippo-internal-token': TEST_INTERNAL_TOKEN },
      payload: { ticketId: ticket.ticketId, phase: 'filled', statusLine: 'FILLED' },
    })
    expect(res.json()).toEqual({ ok: true, routed: false })
    await gwB.app.close()
  })
})
