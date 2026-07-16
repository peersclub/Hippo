/**
 * Request hardening for the admin service.
 *
 * LoginThrottle — sliding-window failure counters keyed by email AND by IP.
 * 5 failures in 15 minutes locks that key out for the remainder of the
 * window (429 + Retry-After). In-memory on purpose: this is per-instance
 * abuse control, not billing data; a restart resetting it is acceptable.
 *
 * originCheck — belt-and-braces CSRF defence on top of the SameSite=Strict
 * cookie: mutating requests that carry an Origin header must match the
 * request's own host (or ADMIN_ALLOWED_ORIGIN). Requests without an Origin
 * (curl, server-to-server) pass — the cookie is what gates those.
 */

const WINDOW_MS = 15 * 60_000
const MAX_FAILURES = 5

export class LoginThrottle {
  private failures = new Map<string, number[]>()

  constructor(
    private readonly windowMs = WINDOW_MS,
    private readonly maxFailures = MAX_FAILURES,
  ) {}

  private prune(key: string, now: number): number[] {
    const cutoff = now - this.windowMs
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff)
    if (kept.length) this.failures.set(key, kept)
    else this.failures.delete(key)
    return kept
  }

  /** Seconds until the oldest failure ages out; 0 when not locked. */
  retryAfterS(keys: string[], now = Date.now()): number {
    let worst = 0
    for (const key of keys) {
      const recent = this.prune(key, now)
      if (recent.length >= this.maxFailures) {
        const oldest = recent[0] ?? now
        worst = Math.max(worst, Math.ceil((oldest + this.windowMs - now) / 1000))
      }
    }
    return worst
  }

  recordFailure(keys: string[], now = Date.now()): void {
    for (const key of keys) {
      const recent = this.prune(key, now)
      recent.push(now)
      this.failures.set(key, recent)
    }
  }

  /** Success clears the email key (not the IP — a spraying IP stays throttled). */
  clear(key: string): void {
    this.failures.delete(key)
  }
}

/** True when the request's Origin (if any) matches the host we're serving.
 * Default ports are normalized on both sides: URL.host strips :80/:443 while
 * a Host header may carry them. */
export function originAllowed(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  allowedOrigin = process.env.ADMIN_ALLOWED_ORIGIN ?? '',
): boolean {
  if (!originHeader) return true // non-browser client; cookie gate applies
  if (allowedOrigin && originHeader === allowedOrigin) return true
  const normalize = (h: string) => h.replace(/:(80|443)$/, '')
  try {
    return normalize(new URL(originHeader).host) === normalize(hostHeader ?? '')
  } catch {
    return false
  }
}
