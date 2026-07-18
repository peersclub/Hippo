#!/usr/bin/env node
/**
 * hippo — the agentic installer.
 *
 * Pipeline (vault: Build Plan/05 Agentic Installer — Hippo CLI):
 *   1. site understanding   2. design comprehension   3. API discovery
 *   4. adapter generation   5. embed integration      6. verification & report
 *
 * `scan` (pre-sales mode) ships v0: deterministic stages 1 & 3 — read-only
 * crawl + spec discovery → Integration Report. `embed` and `verify` are the
 * deterministic halves of stages 5 & 6. The full `init` orchestration (with
 * the agentic comprehension/codegen inside each stage) lands in Phase 4.
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { KoinbxVenueAdapter, SimVenueAdapter, type VenueAdapter } from '@hippo/seam'
import { Command } from 'commander'
import { inProcessDriver } from './conform/in-process-driver.js'
import { renderConformanceReport, renderConformanceSummary } from './conform/report.js'
import { runConformance } from './conform/suite.js'
import type { ConformanceReport } from './conform/types.js'
import { draftAdapterConfig, renderAdapterConfigYaml } from './init/config.js'
import { draftEmbed, injectEmbedTag, renderEmbedMd, renderEmbedSummary } from './init/embed.js'
import { draftMapping, renderMappingTs } from './init/mapping.js'
import { draftRejections, renderRejectionsYaml } from './init/rejections.js'
import type { AdapterConfig } from './init/types.js'
import {
  composeVerification,
  renderVerificationReport,
  renderVerificationSummary,
} from './init/verify.js'
import { registerSandbox, renderRegisterText } from './register/run.js'
import { renderReport, renderSummary } from './scan/report.js'
import { runScan } from './scan/run.js'
import type { ScanResult } from './scan/types.js'

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
  .command('register')
  .description(
    'Self-serve sandbox provisioning: creates a sandbox partner and a one-time claim link for the JWT secret',
  )
  .requiredOption('--venue <name>', 'venue display name')
  .requiredOption('--email <email>', 'engineering contact email')
  .option('--api <url>', 'Hippo provisioning API', 'http://localhost:8794')
  .option(
    '--claim',
    'fetch the one-time JWT secret immediately (printed once, stored nowhere)',
    false,
  )
  .option('--json', 'machine-readable output', false)
  .action(
    async (opts: { venue: string; email: string; api: string; claim: boolean; json: boolean }) => {
      const result = await registerSandbox({
        apiUrl: opts.api,
        email: opts.email,
        venueName: opts.venue,
        claim: opts.claim,
      })
      if (opts.json) console.log(JSON.stringify(result, null, 2))
      else console.log(renderRegisterText(result))
      if (!result.ok) process.exitCode = 1
    },
  )

program
  .command('scan <domain>')
  .description(
    'Pre-sales mode: read-only crawl + API-doc ingestion → draft integration report, no repo access needed',
  )
  .option(
    '--json',
    'also write the typed stage outputs (ScanResult + AdapterConfig) as JSON for `hippo verify`',
  )
  .action(async (domain: string, opts: { json?: boolean }) => {
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
    if (opts.json) {
      const scanJsonPath = path.resolve(process.cwd(), `hippo-scan-${outcome.result.domain}.json`)
      const configJsonPath = path.resolve(
        process.cwd(),
        `hippo-adapter-${outcome.result.domain}.json`,
      )
      await writeFile(scanJsonPath, `${JSON.stringify(outcome.result, null, 2)}\n`, 'utf8')
      await writeFile(configJsonPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      console.log(`Scan JSON:            ${scanJsonPath}`)
      console.log(`Adapter config JSON:  ${configJsonPath}`)
    }
  })

program
  .command('conform')
  .description(
    'Run the CTI conformance suite against a venue adapter (the verifier a generated adapter must pass)',
  )
  .option('--venue <venue>', 'which adapter to exercise: sim | koinbx', 'sim')
  .option('--instrument <symbol>', 'instrument to exercise', 'BTC/USDT')
  .option('--json', 'also write the typed ConformanceReport as JSON for `hippo verify`')
  .action(async (opts: { venue: string; instrument: string; json?: boolean }) => {
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
    if (opts.json) {
      const jsonPath = path.resolve(process.cwd(), `hippo-conform-${opts.venue}.json`)
      await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      console.log(`Report JSON:    ${jsonPath}`)
    }
    if (report.verdict.level === 'Non-conformant') process.exitCode = 1
  })

program
  .command('embed')
  .description(
    'Stage 5: generate the partner-side embed artifacts — one-line web tag, WebView shell URLs, EMBED.md — and optionally inject the tag into an HTML file (idempotent)',
  )
  .requiredOption('--venue <name>', 'venue name for the artifact copy, e.g. acme.exchange')
  .requiredOption('--key <key>', 'partner embed key (data-hippo-key)')
  .option('--gateway <origin>', 'gateway origin (data-hippo-gateway)', 'https://gw.hippo.app')
  .option(
    '--cdn <origin>',
    'CDN origin serving loader.js and embed/mobile.html',
    'https://cdn.hippo.app',
  )
  .option('--theme <theme>', 'dark | light (default: dark hero)')
  .option('--locale <locale>', 'en | hi | hi-Latn | ar')
  .option('--out <file>', 'where to write the Markdown artifact', 'EMBED.md')
  .option('--inject <file>', 'HTML file to inject the tag into (before </body>, never duplicated)')
  .action(
    async (opts: {
      venue: string
      key: string
      gateway: string
      cdn: string
      theme?: string
      locale?: string
      out: string
      inject?: string
    }) => {
      if (opts.theme && opts.theme !== 'dark' && opts.theme !== 'light') {
        console.error(`hippo embed — unknown theme "${opts.theme}" (expected dark | light).`)
        process.exitCode = 1
        return
      }
      let artifacts: ReturnType<typeof draftEmbed>
      try {
        artifacts = draftEmbed({
          venue: opts.venue,
          key: opts.key,
          gateway: opts.gateway,
          cdn: opts.cdn,
          theme: opts.theme as 'dark' | 'light' | undefined,
          locale: opts.locale,
        })
      } catch (err) {
        console.error(`hippo embed — ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
        return
      }
      const outPath = path.resolve(process.cwd(), opts.out)
      await writeFile(outPath, renderEmbedMd(artifacts), 'utf8')
      console.log(renderEmbedSummary(artifacts))
      console.log(`\nEmbed guide written: ${outPath}`)
      if (opts.inject) {
        const injectPath = path.resolve(process.cwd(), opts.inject)
        let html: string
        try {
          html = await readFile(injectPath, 'utf8')
        } catch {
          console.error(`hippo embed — could not read ${injectPath}; nothing was injected.`)
          process.exitCode = 1
          return
        }
        const injected = injectEmbedTag(html, artifacts.tag)
        if (injected.changed) {
          await writeFile(injectPath, injected.html, 'utf8')
          console.log(`Tag injected:        ${injectPath}`)
        } else {
          console.log(`Tag already present: ${injectPath} (unchanged — injection is idempotent)`)
        }
      }
    },
  )

program
  .command('verify')
  .description(
    'Stage 6: compose the final Integration Verification Report from the typed stage outputs (scan, adapter config, conformance) — nothing is re-run',
  )
  .option('--scan <file>', 'ScanResult JSON (from `hippo scan --json`)')
  .option('--config <file>', 'AdapterConfig JSON (from `hippo scan --json`)')
  .option('--conform <file>', 'ConformanceReport JSON (from `hippo conform --json`)')
  .option('--out <file>', 'where to write the report', 'hippo-verify.md')
  .action(async (opts: { scan?: string; config?: string; conform?: string; out: string }) => {
    if (!opts.scan && !opts.config && !opts.conform) {
      console.error('hippo verify — supply at least one stage output: --scan, --config, --conform.')
      process.exitCode = 1
      return
    }
    const readJson = async <T>(file: string, what: string): Promise<T> => {
      const p = path.resolve(process.cwd(), file)
      let raw: string
      try {
        raw = await readFile(p, 'utf8')
      } catch {
        throw new Error(`could not read ${what} at ${p}`)
      }
      try {
        return JSON.parse(raw) as T
      } catch {
        throw new Error(`${what} at ${p} is not valid JSON`)
      }
    }
    try {
      const report = composeVerification({
        scan: opts.scan ? await readJson<ScanResult>(opts.scan, 'ScanResult') : undefined,
        config: opts.config
          ? await readJson<AdapterConfig>(opts.config, 'AdapterConfig')
          : undefined,
        conform: opts.conform
          ? await readJson<ConformanceReport>(opts.conform, 'ConformanceReport')
          : undefined,
      })
      const outPath = path.resolve(process.cwd(), opts.out)
      await writeFile(outPath, renderVerificationReport(report), 'utf8')
      console.log(renderVerificationSummary(report))
      console.log(`\nReport written: ${outPath}`)
      if (report.verdict.level === 'Not ready') process.exitCode = 1
    } catch (err) {
      console.error(`hippo verify — ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
  })

program.parse()
