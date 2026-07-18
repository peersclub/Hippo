/**
 * Stage 6 of `hippo init` (Build Plan/05) — verification & report.
 *
 * Pure composer: takes the typed outputs the earlier stages already produce —
 * a ScanResult (stage 1+3 discovery), an AdapterConfig (stage 3 draft), a
 * ConformanceReport (the `hippo conform` battery) — and renders the final
 * Integration Verification Report: what was discovered, what was generated,
 * the gap list, test results, and a single verdict. Nothing is re-run here and
 * no model is involved; this is the deterministic composition the build plan
 * gates on ("the agent proposes, people approve"). The parts of stage 6 that
 * need a live browser (boot the SDK on the partner's page, screenshot the
 * golden conversation) are deliberately not here.
 */
import type { ConformanceReport } from '../conform/types.js'
import { verdictFor } from '../scan/report.js'
import type { ScanResult } from '../scan/types.js'
import type { AdapterConfig } from './types.js'

export interface VerifyInputs {
  scan?: ScanResult
  config?: AdapterConfig
  conform?: ConformanceReport
  /** ISO timestamp for the report header (injectable for tests). */
  now?: string
}

export interface StageSummary {
  /** e.g. "Discovery" — the row label. */
  stage: string
  /** Which stage artifact / flag supplies it. */
  source: string
  present: boolean
  /** One line: what the stage found, or how to supply it when absent. */
  line: string
  /** Plain-words gaps this stage contributes to the report. */
  gaps: string[]
}

export type VerifyLevel = 'Ready' | 'Almost ready' | 'Not ready'

export interface VerificationReport {
  venue: string
  composedAt: string
  stages: StageSummary[]
  verdict: { level: VerifyLevel; reasons: string[] }
  nextActions: string[]
}

function scanStage(scan: ScanResult | undefined): StageSummary {
  const source = '`hippo scan <domain> --json`'
  if (!scan) {
    return {
      stage: 'Discovery',
      source,
      present: false,
      line: `not supplied — run ${source} and pass \`--scan\``,
      gaps: [],
    }
  }
  const v = verdictFor(scan.capabilities)
  const gaps: string[] = scan.capabilities
    .filter((c) => c.status === 'gap')
    .map((c) => `${c.label} — ${c.consequence}`)
  if (scan.site.csp?.restrictsScripts) {
    gaps.push(
      `CSP restricts \`${scan.site.csp.scriptDirective}\` — Hippo's script host must be allow-listed before the embed loads.`,
    )
  }
  return {
    stage: 'Discovery',
    source,
    present: true,
    line: `${scan.domain}: ${v.found}/${v.total} CTI capabilities matched · readiness ${v.level} · ${scan.spec ? `spec at ${scan.spec.url}` : 'no machine-readable spec found'}`,
    gaps,
  }
}

function adapterStage(config: AdapterConfig | undefined): StageSummary {
  const source = '`hippo scan <domain> --json`'
  if (!config) {
    return {
      stage: 'Adapter',
      source,
      present: false,
      line: `not supplied — ${source} writes the draft adapter config JSON; pass \`--config\``,
      gaps: [],
    }
  }
  const mapped = config.operations.filter((o) => o.status === 'mapped').length
  const gaps: string[] = config.gaps.map((g) => `\`${g}\` has no discovered endpoint.`)
  if (config.baseUrl === null)
    gaps.push('API base URL could not be derived — confirm with the venue.')
  if (config.needsMappingCode.length > 0) {
    gaps.push(
      `mapping.ts functions still to implement for: ${config.needsMappingCode.map((c) => `\`${c}\``).join(', ')} (stage-4 stubs throw until filled in).`,
    )
  }
  return {
    stage: 'Adapter',
    source,
    present: true,
    line: `${mapped}/${config.operations.length} operations mapped · auth: ${config.auth.strategy}`,
    gaps,
  }
}

function conformanceStage(conform: ConformanceReport | undefined): StageSummary {
  const source = '`hippo conform --json`'
  if (!conform) {
    return {
      stage: 'Conformance',
      source,
      present: false,
      line: `not supplied — run ${source} against the venue adapter and pass \`--conform\``,
      gaps: [],
    }
  }
  const v = conform.verdict
  const gaps = conform.checks
    .filter((c) => c.status !== 'pass')
    .map((c) => `${c.label} (${c.status.toUpperCase()}) — ${c.consequence}`)
  return {
    stage: 'Conformance',
    source,
    present: true,
    line: `${v.level} — ${v.passed}/${v.total} checks passed against ${conform.target}`,
    gaps,
  }
}

/**
 * Deterministic verdict:
 *   Ready        — all three stages supplied, the adapter has no capability
 *                  gaps, and the conformance battery is fully Conformant.
 *   Not ready    — the conformance report is missing or Non-conformant (an
 *                  unverified adapter never ships).
 *   Almost ready — everything in between: partial conformance, capability
 *                  gaps, unimplemented mappings, or a missing discovery input.
 */
export function composeVerification(inputs: VerifyInputs): VerificationReport {
  const { scan, config, conform } = inputs
  const stages = [scanStage(scan), adapterStage(config), conformanceStage(conform)]

  const reasons: string[] = []
  let level: VerifyLevel = 'Almost ready'
  if (!conform) {
    level = 'Not ready'
    reasons.push('the adapter has not been run against the CTI conformance suite')
  } else if (conform.verdict.level === 'Non-conformant') {
    level = 'Not ready'
    reasons.push(
      `the adapter is Non-conformant (${conform.verdict.failed} contract violation${conform.verdict.failed === 1 ? '' : 's'})`,
    )
  }
  if (level !== 'Not ready') {
    if (!scan) reasons.push('discovery output was not supplied')
    if (!config) reasons.push('the draft adapter config was not supplied')
    if (config && config.gaps.length > 0)
      reasons.push(
        `${config.gaps.length} CTI capabilit${config.gaps.length === 1 ? 'y has' : 'ies have'} no venue endpoint`,
      )
    if (config && config.needsMappingCode.length > 0)
      reasons.push(`${config.needsMappingCode.length} mapping function(s) are still stubs`)
    if (conform && conform.verdict.level === 'Partial')
      reasons.push(
        `conformance is Partial (${conform.verdict.failed} failed, ${conform.verdict.skipped} skipped)`,
      )
    if (reasons.length === 0) {
      level = 'Ready'
      reasons.push('every supplied stage is clean: no capability gaps, fully conformant adapter')
    }
  }

  const nextActions: string[] = []
  if (!scan) nextActions.push('Run `hippo scan <domain> --json` and supply `--scan`.')
  if (scan?.site.csp?.restrictsScripts)
    nextActions.push("Allow-list Hippo's script host in the site CSP before the embed loads.")
  if (!config)
    nextActions.push(
      'Supply the draft adapter config (`hippo scan --json` writes it) via `--config`.',
    )
  if (config && config.gaps.length > 0)
    nextActions.push(
      `Close the capability gap${config.gaps.length === 1 ? '' : 's'} with the venue: ${config.gaps.map((g) => `\`${g}\``).join(', ')}.`,
    )
  if (config && config.needsMappingCode.length > 0)
    nextActions.push(
      `Implement the mapping.ts stub${config.needsMappingCode.length === 1 ? '' : 's'}: ${config.needsMappingCode.map((c) => `\`${c}\``).join(', ')}.`,
    )
  if (!conform)
    nextActions.push('Run `hippo conform --json` against the venue adapter and supply `--conform`.')
  if (conform && conform.verdict.failed + conform.verdict.skipped > 0)
    nextActions.push(
      `Fix the failing conformance check${conform.verdict.failed === 1 ? '' : 's'} and re-run \`hippo conform\`: ${conform.checks
        .filter((c) => c.status !== 'pass')
        .map((c) => c.label)
        .join(', ')}.`,
    )
  if (nextActions.length === 0)
    nextActions.push(
      'Open the integration PR for partner + Hippo sign-off — the required human gate before anything ships.',
    )

  return {
    venue: config?.venue ?? scan?.domain ?? conform?.target ?? 'unknown venue',
    composedAt: inputs.now ?? new Date().toISOString(),
    stages,
    verdict: { level, reasons },
    nextActions,
  }
}

// ── Markdown rendering ────────────────────────────────────────────────────

/** The final Integration Verification Report — the sign-off artifact. */
export function renderVerificationReport(r: VerificationReport): string {
  const lines: string[] = []
  const push = (...ls: string[]) => lines.push(...ls)

  push(
    `# Hippo Integration Verification — ${r.venue}`,
    '',
    `_Final \`hippo init\` gate (stage 6) · ${r.composedAt.slice(0, 10)} · hippo-verify/0.1 — composed from stage artifacts, nothing re-run._`,
    '',
    '## Verdict',
    '',
    `**${r.verdict.level}** — ${r.verdict.reasons.join('; ')}.`,
    '',
    '## Stage summaries',
    '',
    '| Stage | Supplied | Summary |',
    '| --- | --- | --- |',
  )
  for (const s of r.stages) {
    push(`| ${s.stage} | ${s.present ? 'Yes' : 'No'} | ${s.line} |`)
  }
  push('')

  const gapped = r.stages.filter((s) => s.gaps.length > 0)
  push('## Gaps', '')
  if (gapped.length === 0) {
    push('None — every supplied stage is clean.')
  } else {
    for (const s of gapped) {
      push(`**${s.stage}**`, '')
      for (const g of s.gaps) push(`- ${g}`)
      push('')
    }
  }
  if (gapped.length > 0 && lines[lines.length - 1] === '') lines.pop()

  push('', '## Next actions', '')
  for (const [i, a] of r.nextActions.entries()) push(`${i + 1}. ${a}`)
  push(
    '',
    '---',
    '',
    '_Human sign-off (partner + Hippo) is a required gate — the agent proposes, people approve. An adapter ships only after this report reads **Ready**._',
    '',
  )
  return lines.join('\n')
}

/** Short stdout summary, matching scan/conform conventions. */
export function renderVerificationSummary(r: VerificationReport): string {
  const lines = [`hippo verify — ${r.venue}`]
  for (const s of r.stages) {
    const label = s.stage.padEnd(11)
    lines.push(`  ${label} ${s.present ? s.line : 'not supplied'}`)
  }
  lines.push(`  ${'Verdict'.padEnd(11)} ${r.verdict.level}`)
  return lines.join('\n')
}
