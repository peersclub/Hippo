#!/usr/bin/env node
/**
 * hippo — the agentic installer (STUB).
 *
 * Pipeline (vault: Build Plan/05 Agentic Installer — Hippo CLI):
 *   1. site understanding   2. design comprehension   3. API discovery
 *   4. adapter generation   5. embed integration      6. verification & report
 *
 * Phase 4 (weeks 10–14) fills these in. The verifier (conformance-suite
 * runner) is built BEFORE the generator.
 */
import { Command } from 'commander'

const program = new Command()

program
  .name('hippo')
  .description('Agentic installer — understands a partner site and generates the Hippo integration')
  .version('0.1.0')

program
  .command('init')
  .description('Run inside a partner repo: discover, generate adapter + embed, open a PR (never a silent mutation)')
  .option('--sandbox-only', 'never touch production trading endpoints (default and, for now, only mode)', true)
  .action(() => {
    console.log('hippo init — not yet implemented (Phase 4).')
    console.log('Planned stages: understand site → read design → discover APIs → generate adapter → inject embed → verify & report.')
    process.exitCode = 1
  })

program
  .command('scan <domain>')
  .description('Pre-sales mode: read-only crawl + API-doc ingestion → draft integration report, no repo access needed')
  .action((domain: string) => {
    console.log(`hippo scan ${domain} — not yet implemented (Phase 4).`)
    console.log('Output will be: gap report, draft adapter config, integration effort estimate.')
    process.exitCode = 1
  })

program.parse()
