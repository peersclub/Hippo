// CI size gate: loader must stay under 5KB gzipped (PRD host-safety NFR).
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const LIMIT = 5 * 1024
const bytes = gzipSync(readFileSync(new URL('../dist/loader.js', import.meta.url))).length
console.log(`loader.js: ${(bytes / 1024).toFixed(2)}KB gz (limit ${LIMIT / 1024}KB)`)
if (bytes > LIMIT) {
  console.error('SIZE GATE FAILED — loader exceeds 5KB gz')
  process.exit(1)
}
