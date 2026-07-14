/**
 * Exports the card protocol as JSON Schema (draft 2020-12) for non-TS
 * consumers — the Python intelligence services and the CLI validate
 * against this artifact. Runs after tsc build (imports from dist).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { Frame, Uplink } from '../dist/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'dist')
mkdirSync(out, { recursive: true })

const schema = {
  $comment: 'Generated from @hippo/protocol Zod schemas. Do not edit by hand.',
  frames: z.toJSONSchema(Frame, { target: 'draft-2020-12' }),
  uplinks: z.toJSONSchema(Uplink, { target: 'draft-2020-12' }),
}

writeFileSync(join(out, 'protocol.schema.json'), `${JSON.stringify(schema, null, 2)}\n`)
console.log('wrote dist/protocol.schema.json')
