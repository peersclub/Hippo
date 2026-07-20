/**
 * Redis wiring for the durable session + frame-journal stores.
 *
 * The gateway's stores keep the SAME synchronous interfaces they had when they
 * were pure in-memory (SessionStore / Journal in ./auth and ./sse). Redis is a
 * durable, cross-restart mirror behind those interfaces: frames are written
 * through to a Redis Stream (`session:{id}:frames`, XADD) so a cold pod can
 * replay them on reconnect, and session metadata is a TTL-refreshed key
 * (`session:{id}:meta`). See Build Plan/10 BE Architecture §1 + §4.
 *
 * `RedisClient` is the exact command subset the stores use — both `ioredis`
 * (prod, selected by REDIS_URL) and `ioredis-mock` (tests) satisfy it, so the
 * stores never depend on a live Redis server.
 */
import { Redis } from 'ioredis'

/** The Redis command surface the gateway stores rely on. */
export interface RedisClient {
  xadd(key: string, ...args: (string | number)[]): Promise<string | null>
  xrange(key: string, start: string, end: string): Promise<Array<[string, string[]]>>
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>
  get(key: string): Promise<string | null>
  pexpire(key: string, ttlMs: number): Promise<number>
  del(...keys: string[]): Promise<number>
  quit(): Promise<unknown>
}

/** Real ioredis client from a REDIS_URL. Typed down to the subset we use. */
export function createRedisClient(url: string): RedisClient {
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    // A dead Redis must never take the gateway down — reads/writes are
    // best-effort behind the in-memory hot path, and errors are logged +
    // dropped. Fail FAST, not eventually: commands time out in 2s (a
    // black-holed Redis can't hang resume()), and the offline queue is off so
    // a sustained outage rejects writes into the logged .catch paths instead
    // of buffering them unbounded in memory. Reconnection stays automatic.
    commandTimeout: 2_000,
    enableOfflineQueue: false,
    lazyConnect: false,
  }) as unknown as RedisClient
}
