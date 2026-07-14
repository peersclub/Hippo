#!/usr/bin/env node
/**
 * hippo — the agentic installer.
 *
 * Pipeline (vault: Build Plan/05 Agentic Installer — Hippo CLI):
 *   1. site understanding   2. design comprehension   3. API discovery
 *   4. adapter generation   5. embed integration      6. verification & report
 *
 * `scan` (pre-sales mode) ships v0: deterministic stages 1 & 3 — read-only
 * crawl + spec discovery → Integration Report. `init` lands in Phase 4.
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Command } from 'commander'
import { renderReport, renderSummary } from './scan/report.js'
import { runScan } from './scan/run.js'

const program = new Command()

program
  .name('hippo')
  .description('Agentic installer — understands a partner site and generates the Hippo integration')
  .version('0.1.0')

program
  .command('init')
  .description(
    'Run inside a partner repo: discover, generate adapter + embed, open a PR (never a silent mutation)',
  )
  .option(
    '--sandbox-only',
    'never touch production trading endpoints (default and, for now, only mode)',
    true,
  )
  .action(() => {
    console.log('hippo init — not yet implemented (Phase 4).')
    console.log(
      'Planned stages: understand site → read design → discover APIs → generate adapter → inject embed → verify & report.',
    )
    process.exitCode = 1
  })

program
  .command('scan <domain>')
  .description(
    'Pre-sales mode: read-only crawl + API-doc ingestion → draft integration report, no repo access needed',
  )
  .action(async (domain: string) => {
    const outcome = await runScan(domain)
    if (!outcome.reachable) {
      console.error(`hippo scan — could not reach https://${outcome.domain}/ (${outcome.error})`)
      console.error('Nothing was scanned. Check the domain and try again.')
      process.exitCode = 1
      return
    }
    const reportPath = path.resolve(process.cwd(), `hippo-scan-${outcome.result.domain}.md`)
    await writeFile(reportPath, renderReport(outcome.result), 'utf8')
    console.log(renderSummary(outcome.result))
    console.log(`\nReport written: ${reportPath}`)
  })

program.parse()
