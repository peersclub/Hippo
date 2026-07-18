/**
 * `hippo register` — self-serve sandbox provisioning against the Hippo
 * provisioning API (services/admin). Returns the embed key immediately and a
 * ONE-TIME claim path for the JWT secret. The secret is printed (with
 * --claim) or left for the operator to fetch — never written to disk.
 */

export type RegisterOptions = {
  apiUrl: string
  email: string
  venueName: string
  locales?: string[]
  /** Fetch the one-time secret immediately (prints once, stores nowhere). */
  claim?: boolean
}

export type RegisterResult =
  | {
      ok: true
      partnerId: string
      partnerKey: string
      status: string
      claimUrl: string
      claimExpiresInS: number
      /** Present only when opts.claim was set and the fetch succeeded. */
      jwtSecret?: string
    }
  | { ok: false; error: string; status?: number }

export async function registerSandbox(
  opts: RegisterOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<RegisterResult> {
  const base = opts.apiUrl.replace(/\/+$/, '')
  let res: Response
  try {
    res = await fetchImpl(`${base}/v1/provision/sandbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: opts.email,
        venueName: opts.venueName,
        ...(opts.locales?.length ? { locales: opts.locales } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    return { ok: false, error: `provisioning API unreachable at ${base}: ${String(err)}` }
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === 'string' ? body.error : `provisioning failed (${res.status})`,
    }
  }

  const result: RegisterResult = {
    ok: true,
    partnerId: String(body.partnerId),
    partnerKey: String(body.partnerKey),
    status: String(body.status),
    claimUrl: `${base}${String(body.claimPath)}`,
    claimExpiresInS: Number(body.claimExpiresInS ?? 0),
  }

  if (opts.claim) {
    try {
      const claimRes = await fetchImpl(result.claimUrl, { signal: AbortSignal.timeout(10_000) })
      if (claimRes.ok) {
        const claim = (await claimRes.json()) as { jwtSecret?: string }
        if (claim.jwtSecret) result.jwtSecret = claim.jwtSecret
      }
    } catch {
      /* claim URL stays valid for a manual fetch */
    }
  }

  return result
}

export function renderRegisterText(r: RegisterResult): string {
  if (!r.ok) return `hippo register — ${r.error}`
  const lines = [
    'Sandbox partner provisioned.',
    '',
    `  partnerId:   ${r.partnerId}`,
    `  embed key:   ${r.partnerKey}   (public — goes in the script tag)`,
    `  status:      ${r.status}  (production activation is operator-approved)`,
  ]
  if (r.jwtSecret) {
    lines.push(
      '',
      '  JWT secret (shown ONCE — store it in your vault now):',
      `  ${r.jwtSecret}`,
      '',
      '  The claim link is now spent. Your backend signs user session tokens',
      '  (HS256, sub = your user id, exp <= 5 min) with this secret.',
    )
  } else {
    lines.push(
      '',
      `  Fetch your JWT secret ONCE (expires in ${Math.round(r.claimExpiresInS / 60)} min):`,
      `  curl ${r.claimUrl}`,
    )
  }
  return lines.join('\n')
}
