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
import { KoinbxVenueAdapter, SimVenueAdapter, type VenueAdapter } from '@hippo/seam'
import { Command } from 'commander'
import { inProcessDriver } from './conform/in-process-driver.js'
import { renderConformanceReport, renderConformanceSummary } from './conform/report.js'
import { runConformance } from './conform/suite.js'
import { draftAdapterConfig, renderAdapterConfigYaml } from './init/config.js'
import { draftMapping, renderMappingTs } from './init/mapping.js'
import { draftRejections, renderRejectionsYaml } from './init/rejections.js'
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
    const configPath = path.resolve(process.cwd(), `hippo-adapter-${outcome.result.domain}.yaml`)
    const mappingPath = path.resolve(process.cwd(), `hippo-mapping-${outcome.result.domain}.ts`)
    const rejectionsPath = path.resolve(
      process.cwd(),
      `hippo-rejections-${outcome.result.domain}.yaml`,
    )
    const config = draftAdapterConfig(outcome.result)
    await writeFile(reportPath, renderReport(outcome.result), 'utf8')
    await writeFile(configPath, renderAdapterConfigYaml(config), 'utf8')
    await writeFile(mappingPath, renderMappingTs(draftMapping(config)), 'utf8')
    await writeFile(rejectionsPath, renderRejectionsYaml(draftRejections(outcome.result)), 'utf8')
    console.log(renderSummary(outcome.result))
    console.log(`\nReport written:       ${reportPath}`)
    console.log(`Draft adapter config: ${configPath}`)
    console.log(`Mapping stubs:        ${mappingPath}`)
    console.log(`Rejection map:        ${rejectionsPath}`)
  })

program
  .command('conform')
  .description(
    'Run the CTI conformance suite against a venue adapter (the verifier a generated adapter must pass)',
  )
  .option('--venue <venue>', 'which adapter to exercise: sim | koinbx', 'sim')
  .option('--instrument <symbol>', 'instrument to exercise', 'BTC/USDT')
  .action(async (opts: { venue: string; instrument: string }) => {
    let adapter: VenueAdapter
    if (opts.venue === 'koinbx') {
      const { KOINBX_API_KEY, KOINBX_SECRET, KOINBX_BASE_URL } = process.env
      if (!KOINBX_API_KEY || !KOINBX_SECRET || !KOINBX_BASE_URL) {
        console.error(
          'hippo conform --venue koinbx requires KOINBX_API_KEY, KOINBX_SECRET and KOINBX_BASE_URL.',
        )
        process.exitCode = 1
        return
      }
      adapter = new KoinbxVenueAdapter({
        apiKey: KOINBX_API_KEY,
        secret: KOINBX_SECRET,
        baseUrl: KOINBX_BASE_URL,
      })
    } else if (opts.venue === 'sim') {
      adapter = new SimVenueAdapter()
    } else {
      console.error(`hippo conform — unknown venue "${opts.venue}" (expected sim | koinbx).`)
      process.exitCode = 1
      return
    }

    const driver = inProcessDriver(adapter, `${opts.venue} venue (in-process)`)
    const report = await runConformance(driver, {
      instrument: opts.instrument,
      now: new Date().toISOString(),
    })
    const reportPath = path.resolve(process.cwd(), `hippo-conform-${opts.venue}.md`)
    await writeFile(reportPath, renderConformanceReport(report), 'utf8')
    console.log(renderConformanceSummary(report))
    console.log(`\nReport written: ${reportPath}`)
    if (report.verdict.level === 'Non-conformant') process.exitCode = 1
  })

program.parse()
