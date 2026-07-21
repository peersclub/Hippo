/**
 * Conformance report rendering (pure) — the artifact `hippo conform` writes and
 * the fitness signal for the codegen dogfood (Build Plan/05: "regenerate the
 * Assetworks adapter blind; diff against hand-built = quality score"). Markdown
 * report + short stdout summary, matching scan/report.ts conventions.
 */
import type { CheckResult, ConformanceReport } from './types.js'

const MARK: Record<CheckResult['status'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  skip: 'SKIP',
}

export function renderConformanceReport(r: ConformanceReport): string {
  const lines: string[] = []
  const push = (...ls: string[]) => lines.push(...ls)
  const v = r.verdict

  push(
    `# Hippo CTI Conformance — ${r.target}`,
    '',
    `_Canonical Trading Interface behavioural conformance · ${r.ranAt ? r.ranAt.slice(0, 10) : 'unversioned run'} · hippo-conform/0.1_`,
    '',
    '## Verdict',
    '',
    `**${v.level}** — ${v.passed}/${v.total} checks passed${v.failed > 0 ? `, ${v.failed} failed` : ''}${v.skipped > 0 ? `, ${v.skipped} skipped` : ''}.`,
    '',
    '## Checks',
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
  )
  for (const c of r.checks) {
    push(`| ${c.label} | ${MARK[c.status]} | ${c.detail} |`)
  }
  push('')

  const problems = r.checks.filter((c) => c.status !== 'pass')
  push('## Consequences of gaps', '')
  if (problems.length === 0) {
    push('None — the adapter satisfies every Canonical Trading Interface check.')
  } else {
    for (const p of problems) push(`- **${p.label}** (${MARK[p.status]}) — ${p.consequence}`)
  }
  push(
    '',
    '---',
    '',
    '_This suite is venue-neutral: it grades a generated adapter against the same battery the hand-built Assetworks adapter passes. A `FAIL` is a contract violation; a `SKIP` means an earlier failure left nothing to test._',
    '',
  )
  return lines.join('\n')
}

export function renderConformanceSummary(r: ConformanceReport): string {
  const v = r.verdict
  const failed = r.checks.filter((c) => c.status === 'fail').map((c) => c.label)
  const lines = [
    `hippo conform — ${r.target}`,
    `  Verdict   ${v.level} (${v.passed}/${v.total} passed)`,
  ]
  if (failed.length > 0) lines.push(`  Failed    ${failed.join(', ')}`)
  return lines.join('\n')
}
