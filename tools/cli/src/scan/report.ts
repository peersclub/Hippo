/**
 * Integration Report rendering (pure) — the artifact you hand a prospect.
 * Markdown report + short stdout summary from a ScanResult.
 */
import { TRADE_FEATURE_IDS, TRADE_FEATURE_LABELS } from './features.js'
import type { CapabilityMatch, ScanResult, VenueCapabilitiesShape } from './types.js'

export interface Verdict {
  level: 'High' | 'Medium' | 'Low'
  found: number
  total: number
}

export function verdictFor(capabilities: CapabilityMatch[]): Verdict {
  const found = capabilities.filter((c) => c.status === 'found').length
  const total = capabilities.length
  const level = found >= 6 ? 'High' : found >= 3 ? 'Medium' : 'Low'
  return { level, found, total }
}

function cspLine(r: ScanResult): string {
  const csp = r.site.csp
  if (!csp)
    return 'No Content-Security-Policy header — the embed script can load without CSP changes.'
  const tag = csp.reportOnly ? ' (report-only, not enforced)' : ''
  if (!csp.restrictsScripts) {
    return `CSP present${tag} but scripts are not restricted — no CSP change needed for the embed.`
  }
  const hosts =
    csp.scriptHosts.length > 0 ? ` Allowed script hosts: ${csp.scriptHosts.join(', ')}.` : ''
  return `CSP restricts \`${csp.scriptDirective}\`${tag} — Hippo's script host must be allow-listed before the embed loads.${hosts}`
}

function code(s: string): string {
  return `\`${s}\``
}

/** Status cell for a trade feature: enabled + extracted params, or the honest gaps. */
function tradeFeatureStatus(features: VenueCapabilitiesShape, id: keyof VenueCapabilitiesShape) {
  const feature = features[id]
  if (!feature) return 'Not detected'
  const details: string[] = []
  if ('maxLeverage' in feature && feature.maxLeverage !== undefined) {
    details.push(`max leverage ${feature.maxLeverage}x`)
  }
  if ('marginModes' in feature && feature.marginModes && feature.marginModes.length > 0) {
    details.push(`margin: ${feature.marginModes.join('/')}`)
  }
  if (feature.paramsIncomplete) details.push('params incomplete — confirm with the venue')
  return details.length > 0 ? `Enabled (${details.join('; ')})` : 'Enabled'
}

export function renderReport(r: ScanResult): string {
  const v = verdictFor(r.capabilities)
  const lines: string[] = []
  const push = (...ls: string[]) => lines.push(...ls)

  push(
    `# Hippo Integration Scan — ${r.domain}`,
    '',
    `_Read-only pre-sales scan · ${r.scannedAt.slice(0, 10)} · hippo-scan/0.1 · no credentials used, no state changed._`,
    '',
    '## Site profile',
    '',
    '| | |',
    '| --- | --- |',
    `| Final URL | ${r.site.finalUrl} |`,
    `| HTTP status | ${r.site.status} |`,
    `| Framework | ${r.site.framework.name}${r.site.framework.evidence ? ` — ${code(r.site.framework.evidence)}` : ''} |`,
    `| Title | ${r.site.title ?? '—'} |`,
    `| Locales | ${r.site.locales.length > 0 ? r.site.locales.join(', ') : 'none declared'} |`,
    `| Server | ${[r.site.server, r.site.poweredBy].filter(Boolean).join(' · ') || 'not disclosed'} |`,
    '',
    `**CSP posture:** ${cspLine(r)}`,
    '',
    '## API surface',
    '',
  )

  if (r.spec) {
    push(
      `**Spec found:** ${code(r.spec.url)} — ${r.spec.version}${r.spec.title ? `, “${r.spec.title}”` : ''}, ${r.spec.pathCount} paths.`,
    )
  } else {
    push(
      '**No machine-readable API spec found.** Common OpenAPI/Swagger locations were probed (table below); the capability map reflects public discoverability only, not the venue’s actual API.',
    )
  }
  push(
    '',
    `**Declared auth schemes:** ${r.authSchemes.length > 0 ? r.authSchemes.join(' · ') : 'none declared in spec'}`,
    '',
  )

  if (r.probes.length > 0) {
    push('| Probe | Status | Content-Type |', '| --- | --- | --- |')
    for (const p of r.probes) {
      push(
        `| ${code(p.url)} | ${p.status ?? 'unreachable'} | ${p.contentType ?? '—'}${p.note ? ` (${p.note})` : ''} |`,
      )
    }
    push('')
  }

  if (r.robots?.fetched) {
    const hints =
      r.robots.apiDisallows.length > 0
        ? `API-related disallows: ${r.robots.apiDisallows.map(code).join(', ')}`
        : 'no API-related disallow rules'
    push(
      `**robots.txt:** ${r.robots.sitemaps.length} sitemap(s), ${r.robots.disallowCount} disallow rule(s); ${hints}.`,
      '',
    )
  } else {
    push('**robots.txt:** not available.', '')
  }

  push('## CTI capability map', '', '| Capability | Status | Endpoints |', '| --- | --- | --- |')
  for (const c of r.capabilities) {
    const endpoints = c.endpoints.length > 0 ? c.endpoints.map(code).join('<br>') : '—'
    push(`| ${c.label} | ${c.status === 'found' ? 'Found' : 'GAP'} | ${endpoints} |`)
  }
  push('')

  if (r.tradeFeatures) {
    const features = r.tradeFeatures
    push('## Trade features', '', '| Feature | Status | Evidence |', '| --- | --- | --- |')
    for (const id of TRADE_FEATURE_IDS) {
      const evidence = features[id]?.endpoints ?? []
      push(
        `| ${TRADE_FEATURE_LABELS[id]} | ${tradeFeatureStatus(features, id)} | ${
          evidence.length > 0 ? evidence.map(code).join('<br>') : '—'
        } |`,
      )
    }
    push(
      '',
      '_Trade features are keyword candidates from the public spec — treat "Enabled" as a lead to confirm with the venue, not proof._',
      '',
    )
  }

  const gaps = r.capabilities.filter((c) => c.status === 'gap')
  push('## Gaps', '')
  if (gaps.length === 0) {
    push('None — all eight CTI capabilities have candidate endpoints in the discovered surface.')
  } else {
    for (const g of gaps) push(`- **${g.label}** — ${g.consequence}`)
  }
  push(
    '',
    '## Verdict',
    '',
    `**Integration readiness: ${v.level}** — ${v.found} of ${v.total} Canonical Trading Interface capabilities matched from the publicly discoverable API surface.`,
    '',
    '---',
    '',
    '_Next step: run `hippo init` inside the repo — it turns this discovery into the adapter config, embed snippet, and conformance suite, delivered as a reviewable PR._',
    '',
  )
  return lines.join('\n')
}

export function renderSummary(r: ScanResult): string {
  const v = verdictFor(r.capabilities)
  const gaps = r.capabilities.filter((c) => c.status === 'gap').map((c) => c.label)
  const lines = [
    `hippo scan — ${r.domain}`,
    `  Site      ${r.site.framework.name} · ${r.site.csp ? (r.site.csp.restrictsScripts ? 'CSP restricts scripts' : 'CSP present, scripts unrestricted') : 'no CSP'} · locales: ${r.site.locales.join(', ') || 'none declared'}`,
    `  API spec  ${r.spec ? `${r.spec.url} (${r.spec.version}, ${r.spec.pathCount} paths)` : 'none found at common locations'}`,
    `  CTI       ${v.found}/${v.total} capabilities matched${gaps.length > 0 ? ` · gaps: ${gaps.join(', ')}` : ''}`,
  ]
  if (r.tradeFeatures) {
    const features = r.tradeFeatures
    const enabled = TRADE_FEATURE_IDS.filter((id) => features[id] !== undefined).map((id) =>
      features[id]?.paramsIncomplete ? `${id} (params incomplete)` : id,
    )
    lines.push(`  Features  ${enabled.length > 0 ? enabled.join(', ') : 'none detected'}`)
  }
  lines.push(`  Verdict   Integration readiness: ${v.level}`)
  return lines.join('\n')
}
