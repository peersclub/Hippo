/**
 * In-panel identity (username + 4-digit PIN, demo-grade — Build Plan panel-
 * identity track). Traders claim a username inside the Hippo panel; from the
 * moment of adoption the session's effective userId becomes
 * `id:<username_lower>` (the `id:` namespace can never collide with a host-
 * minted sub), so memory/persona/learned facts key to the PERSON and travel
 * across browsers/devices.
 *
 * PINs are scrypt-hashed via @hippo/stores' shared password helper — a raw
 * PIN is never stored or logged. Sign-in attempts are rate-limited in memory
 * (5 failures per session+username per 15 min). Every outcome is answered
 * with an `identity` frame (journaled, so a resume replays it); the SDK
 * renders those frames — this module's job ends at emitting them.
 */
import { hashPassword, type UserIdentityStore, verifyPassword } from '@hippo/stores'
import type { Session, SessionStore } from '../plugins/auth.js'
import type { EmitFrame } from '../plugins/sse.js'

type IdentityClaimUplink = Extract<import('@hippo/protocol').Uplink, { kind: 'identity_claim' }>

type Log = {
  warn: (obj: object, msg?: string) => void
}

/** Failed sign-in attempts allowed per (session, username) per window. */
const MAX_PIN_FAILURES = 5
const FAILURE_WINDOW_MS = 15 * 60_000

export type IdentityHandler = {
  /** Handle an identity_claim uplink (create/signin/signout). */
  handleClaim(session: Session, uplink: IdentityClaimUplink): Promise<void>
  /** Session start: if the session's sub has a link, adopt the identity and
   * emit the journaled identity {status:'ok'} frame. Best-effort. */
  restore(session: Session): Promise<void>
}

/** The host/cookie user this session belongs to — the link key. Anonymous dev
 * sessions fall back to the session id (their link never outlives them). */
function subOf(session: Session): string {
  return session.venueUserId ?? session.id
}

export function createIdentityHandler(deps: {
  store: UserIdentityStore
  emit: EmitFrame
  log: Log
  sessions: SessionStore
}): IdentityHandler {
  const { store, emit, log, sessions } = deps

  /** Failed-PIN counters, keyed `${sessionId}:${usernameLower}`. In-memory by
   * design (demo-grade): a restart resets the window, never the pin_hash. */
  const failures = new Map<string, { count: number; resetAt: number }>()

  function isRateLimited(key: string): boolean {
    const entry = failures.get(key)
    if (!entry) return false
    if (entry.resetAt <= Date.now()) {
      failures.delete(key)
      return false
    }
    return entry.count >= MAX_PIN_FAILURES
  }

  function recordFailure(key: string): void {
    const entry = failures.get(key)
    if (!entry || entry.resetAt <= Date.now()) {
      failures.set(key, { count: 1, resetAt: Date.now() + FAILURE_WINDOW_MS })
      return
    }
    entry.count += 1
  }

  /** Bind the identity to the session: from this moment userKey() resolves to
   * `id:<usernameLower>`, so every memory/persona/learned-facts call keys to
   * the person. Mirrored to durable session meta (Redis stores) so a resumed
   * session keeps the adopted id. */
  function adopt(session: Session, username: string, usernameLower: string): void {
    session.identity = { username, usernameLower }
    sessions.persistMeta?.(session)
  }

  async function handleClaim(session: Session, uplink: IdentityClaimUplink): Promise<void> {
    const partnerId = session.partner.partnerId
    const sub = subOf(session)

    if (uplink.mode === 'signout') {
      session.identity = null
      sessions.persistMeta?.(session)
      // Best-effort: the session already reverted to its host-minted sub even
      // if the durable unlink write fails.
      try {
        await store.unlink(partnerId, sub)
      } catch (err) {
        log.warn({ err }, 'identity unlink failed')
      }
      emit(session, { type: 'identity', status: 'signed_out' })
      return
    }

    // create/signin both need a username + PIN. The uplink schema already
    // enforces the formats when present; missing fields land here.
    const { username, pin } = uplink
    if (!username || !pin) {
      emit(session, {
        type: 'identity',
        status: 'invalid',
        note: 'A username (3–24 letters, digits, - or _) and a 4-digit PIN are required.',
      })
      return
    }
    const usernameLower = username.toLowerCase()

    try {
      if (uplink.mode === 'create') {
        const created = await store.create(partnerId, username, hashPassword(pin))
        if (!created) {
          emit(session, {
            type: 'identity',
            status: 'taken',
            note: `"${username}" is already claimed — sign in with its PIN, or pick another name.`,
          })
          return
        }
        await store.link(partnerId, sub, usernameLower)
        adopt(session, created.username, usernameLower)
        emit(session, { type: 'identity', status: 'ok', username: created.username })
        return
      }

      // signin
      const limitKey = `${session.id}:${usernameLower}`
      if (isRateLimited(limitKey)) {
        emit(session, {
          type: 'identity',
          status: 'rate_limited',
          note: 'Too many PIN attempts — try again in a few minutes.',
        })
        return
      }
      const identity = await store.get(partnerId, usernameLower)
      // Unknown usernames answer exactly like a wrong PIN (and count against
      // the same limit), so sign-in can't be used to enumerate names.
      if (!identity || !verifyPassword(pin, identity.pinHash)) {
        recordFailure(limitKey)
        emit(session, {
          type: 'identity',
          status: 'wrong_pin',
          note: "That username and PIN don't match.",
        })
        return
      }
      failures.delete(limitKey)
      await store.link(partnerId, sub, usernameLower)
      store.touch(partnerId, usernameLower).catch(() => {})
      adopt(session, identity.username, usernameLower)
      emit(session, { type: 'identity', status: 'ok', username: identity.username })
    } catch (err) {
      // Store down → an honest non-ok answer, never a dropped uplink.
      log.warn({ err, mode: uplink.mode }, 'identity store unavailable')
      emit(session, {
        type: 'identity',
        status: 'invalid',
        note: 'Identity is temporarily unavailable — try again in a moment.',
      })
    }
  }

  async function restore(session: Session): Promise<void> {
    // A resumed session already carries its identity in durable meta; the
    // journal replay re-delivers the original ok frame. This path is for
    // FRESH sessions whose sub claimed an identity in an earlier session.
    if (session.identity) return
    try {
      const identity = await store.linkedIdentity(session.partner.partnerId, subOf(session))
      if (!identity) return
      adopt(session, identity.username, identity.usernameLower)
      store.touch(session.partner.partnerId, identity.usernameLower).catch(() => {})
      emit(session, { type: 'identity', status: 'ok', username: identity.username })
    } catch (err) {
      log.warn({ err }, 'identity restore failed — session stays anonymous')
    }
  }

  return { handleClaim, restore }
}
