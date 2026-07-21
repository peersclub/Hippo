/**
 * Stage 4b of `hippo init` (Build Plan/05) — the `rejections.yaml` generator.
 *
 * Maps a venue's documented error responses onto canonical rejection reasons
 * (plain words + a fix), deterministically from the error responses the scan
 * extracted from the venue's OpenAPI doc. Where the venue documents no errors
 * — or leaves an important reason unmapped — the gap is flagged rather than
 * invented. No model involved: this is plain-code classification the LLM
 * stages can later enrich, mirroring `config.ts`.
 */
import type { ErrorResponseFinding, ScanResult } from '../scan/types.js'

/** Hippo-side rejection categories a trader can be shown plain words for. */
export type CanonicalReason =
  | 'invalid_request'
  | 'auth_failed'
  | 'insufficient_funds'
  | 'rate_limited'
  | 'not_found'
  | 'venue_error'
  | 'unknown'

interface ReasonCopy {
  reason: string
  fix: string
}

const CANONICAL: Record<CanonicalReason, ReasonCopy> = {
  invalid_request: {
    reason:
      'The venue rejected the request as malformed or out of range (bad symbol, size, or price).',
    fix: 'Validate order parameters against the instrument limits before sending.',
  },
  auth_failed: {
    reason: 'The venue rejected the credentials or request signature.',
    fix: 'Re-check the API key and HMAC signing — see signedPost() in services/seam/src/koinbx-venue.ts.',
  },
  insufficient_funds: {
    reason: 'The account did not have enough balance to place the order.',
    fix: 'Surface an affordability hint before confirm; reduce size or top up the balance.',
  },
  rate_limited: {
    reason: 'The venue throttled the request.',
    fix: "Back off and retry within the venue's rate-limit window.",
  },
  not_found: {
    reason: 'The referenced order or symbol was not found.',
    fix: 'Confirm the order id / symbol; treat a missing resting order as terminal (see the Assetworks poll reconciler).',
  },
  venue_error: {
    reason: 'The venue returned a server-side error.',
    fix: 'Retry with backoff; if it persists, surface a plain-words failure and hand back to the venue.',
  },
  unknown: {
    reason: 'Undocumented or unrecognized venue error.',
    fix: 'Capture the raw venue response and add a mapping here.',
  },
}

/** Reasons a trading adapter really ought to handle; flagged as gaps if unmapped. */
const IMPORTANT: CanonicalReason[] = [
  'invalid_request',
  'auth_failed',
  'insufficient_funds',
  'rate_limited',
]

const GAP_HINT: Record<CanonicalReason, string> = {
  invalid_request: 'prepared tickets can still be rejected for bad parameters at confirm.',
  auth_failed: 'a bad key or signature is the most common first-run failure.',
  insufficient_funds: 'the most common real rejection; without it the trader sees a raw error.',
  rate_limited: 'polling reconciliation and bursty confirms will hit venue rate limits.',
  not_found: 'cancel and status reads reference an order id the venue may not know.',
  venue_error: 'transient venue outages need a graceful hand-back, not a stack trace.',
  unknown: 'a catch-all is needed so unmapped errors still read as plain words.',
}

/** Deterministic status-code + keyword classification. Keywords win over codes. */
export function classifyRejection(status: string, description: string | null): CanonicalReason {
  const text = (description ?? '').toLowerCase()
  if (/insufficient|not enough|balance|\bfunds\b/.test(text)) return 'insufficient_funds'
  if (/signature|api.?key|unauthor|forbidden|\bauth|credential/.test(text)) return 'auth_failed'
  if (/rate.?limit|throttl|too many/.test(text)) return 'rate_limited'
  if (/not found|unknown order|no such/.test(text)) return 'not_found'
  if (status === '401' || status === '403') return 'auth_failed'
  if (status === '429') return 'rate_limited'
  if (status === '404') return 'not_found'
  if (status === '400' || status === '422') return 'invalid_request'
  if (/^5\d\d$/.test(status)) return 'venue_error'
  return 'unknown'
}

export interface RejectionEntry {
  canonical: CanonicalReason
  /** Venue HTTP statuses that classified to this reason, sorted. */
  statuses: string[]
  /** Venue endpoints where those errors are documented, sorted. */
  endpoints: string[]
  reason: string
  fix: string
}

export interface RejectionsDoc {
  venue: string
  /** True when the venue documented at least one error response. */
  documented: boolean
  entries: RejectionEntry[]
  /** Plain-words notes where the venue left rejection handling underspecified. */
  gaps: string[]
}

/**
 * Deterministically map a scan's documented error responses to canonical
 * rejection reasons. Pure — reads only `scan.errorResponses`.
 */
export function draftRejections(scan: ScanResult): RejectionsDoc {
  const findings: ErrorResponseFinding[] = scan.errorResponses ?? []

  const byCanonical = new Map<CanonicalReason, { statuses: Set<string>; endpoints: Set<string> }>()
  for (const f of findings) {
    const canonical = classifyRejection(f.status, f.description)
    const agg = byCanonical.get(canonical) ?? { statuses: new Set(), endpoints: new Set() }
    agg.statuses.add(f.status)
    agg.endpoints.add(f.endpoint)
    byCanonical.set(canonical, agg)
  }

  const entries: RejectionEntry[] = [...byCanonical.entries()]
    .map(([canonical, agg]) => ({
      canonical,
      statuses: [...agg.statuses].sort(),
      endpoints: [...agg.endpoints].sort(),
      reason: CANONICAL[canonical].reason,
      fix: CANONICAL[canonical].fix,
    }))
    .sort((a, b) => a.canonical.localeCompare(b.canonical))

  const gaps: string[] = []
  if (findings.length === 0) {
    gaps.push(
      'The venue documents no error responses in its spec — rejection reasons must be captured from live venue errors and mapped here by hand.',
    )
  } else {
    for (const c of IMPORTANT) {
      if (!byCanonical.has(c)) gaps.push(`No documented error maps to "${c}" — ${GAP_HINT[c]}`)
    }
  }

  return { venue: scan.domain, documented: findings.length > 0, entries, gaps }
}

// ── YAML rendering ────────────────────────────────────────────────────────
// Hand-rolled for this known-shaped document — no YAML dependency, matching
// config.ts. Values that can contain spaces, slashes or quotes are quoted.

const q = (s: string): string => `"${s.replace(/"/g, '\\"')}"`

export function renderRejectionsYaml(doc: RejectionsDoc): string {
  const lines: string[] = []
  const push = (...ls: string[]) => lines.push(...ls)

  push(
    `# Hippo rejection map (draft) — ${doc.venue}`,
    '# Generated by `hippo init` from the scanned OpenAPI error responses.',
    '# Maps venue errors to canonical rejection reasons the trader is shown in',
    '# plain words, each with a fix. Gaps flag where the venue underspecifies',
    '# errors — fill those from live venue responses.',
    '',
    `venue: ${q(doc.venue)}`,
    `documented: ${doc.documented}`,
    '',
    'rejections:',
  )

  if (doc.entries.length === 0) {
    push('  [] # no documented error responses to map')
  } else {
    for (const e of doc.entries) {
      push(`  ${e.canonical}:`)
      push('    venueStatuses:')
      for (const s of e.statuses) push(`      - ${q(s)}`)
      push('    endpoints:')
      for (const ep of e.endpoints) push(`      - ${q(ep)}`)
      push(`    reason: ${q(e.reason)}`)
      push(`    fix: ${q(e.fix)}`)
    }
  }

  push('', 'gaps:')
  if (doc.gaps.length === 0) {
    push('  [] # every important rejection reason is documented and mapped')
  } else {
    for (const g of doc.gaps) push(`  - ${q(g)}`)
  }

  push('')
  return lines.join('\n')
}
