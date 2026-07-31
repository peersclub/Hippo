/**
 * Server-side CSV parsing + digest for the file-upload pipeline.
 *
 * The raw file NEVER reaches the model: the gateway parses it here and ships a
 * compact structured digest (columns, row count, numeric summaries, per-asset
 * totals) to the intelligence service instead. Hand-rolled parser on purpose —
 * no new deps for a bounded 512KB input; quoted fields (RFC 4180 style, with
 * "" escapes) are supported, rows are capped, and every cell is length-clipped
 * so a hostile file cannot bloat the prompt.
 */

/** Data rows parsed at most (beyond this the digest is marked truncated). */
export const CSV_MAX_ROWS = 2000

/** Digest bounds — everything the model sees is clipped by these. */
const MAX_COLUMNS = 32
const MAX_CELL_CHARS = 60
const MAX_SAMPLE_ROWS = 3
const MAX_ASSET_GROUPS = 20

export type NumericSummary = { count: number; min: number; max: number; sum: number }

export type AssetTotal = { asset: string; rows: number; totalQuantity?: number }

export type CsvDigest = {
  columns: string[]
  /** Data rows parsed (header excluded), capped at CSV_MAX_ROWS. */
  rowCount: number
  /** True when the file had more rows than the cap — the digest is partial. */
  truncated: boolean
  /** Per-column stats for columns that are predominantly numeric. */
  numericSummary: Record<string, NumericSummary>
  /** Grouped totals when an asset-like column is recognizable; null otherwise. */
  assetTotals: AssetTotal[] | null
  /** First few data rows, cells clipped — gives the model concrete shape. */
  sampleRows: string[][]
}

/**
 * Minimal CSV parser: comma-separated, quoted fields with "" escapes, CRLF or
 * LF line endings, UTF-8 BOM stripped. Stops after `maxRows` PARSED rows
 * (header included in the count it returns) and reports whether it stopped
 * early. Never throws — a malformed tail simply parses as literal text.
 */
export function parseCsv(text: string, maxRows: number): { rows: string[][]; truncated: boolean } {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let sawAny = false

  const endCell = () => {
    row.push(cell)
    cell = ''
  }
  const endRow = () => {
    endCell()
    // Skip fully-empty lines (common trailing newline case).
    if (row.length > 1 || (row[0] ?? '').trim() !== '') rows.push(row)
    row = []
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string
    sawAny = true
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"' && cell === '') {
      inQuotes = true
    } else if (ch === ',') {
      endCell()
    } else if (ch === '\n') {
      endRow()
      if (rows.length >= maxRows) {
        // More content beyond the cap → truncated (ignore a bare trailing \n).
        return { rows, truncated: input.slice(i + 1).trim() !== '' }
      }
    } else if (ch !== '\r') {
      cell += ch
    }
  }
  if (sawAny && (cell !== '' || row.length > 0)) endRow()
  return { rows, truncated: false }
}

const ASSET_COLUMN_RE = /^(asset|symbol|coin|ticker|instrument|pair|market|currency)s?$/
const QUANTITY_COLUMN_RE = /(qty|quantity|size|amount|units|balance)/

function clip(cell: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate sanitization
  const clean = cell.replaceAll(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return clean.length > MAX_CELL_CHARS ? `${clean.slice(0, MAX_CELL_CHARS)}…` : clean
}

/** Parse a cell as a number, tolerating thousands separators and % / currency
 * prefixes. Returns null for anything that isn't cleanly numeric. */
function parseNumericCell(cell: string): number | null {
  const cleaned = cell
    .trim()
    .replaceAll(',', '')
    .replace(/^[$€£₹]/, '')
    .replace(/%$/, '')
  if (cleaned === '' || !/^[+-]?\d*\.?\d+(e[+-]?\d+)?$/i.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/** Round away float-accumulation noise without distorting real precision. */
function tidy(n: number): number {
  return Number(n.toPrecision(12))
}

/**
 * Parse a CSV text and summarize it into the compact digest the intelligence
 * service receives. Pure and bounded: output size is capped regardless of the
 * input (columns/rows/cells/groups all clipped).
 */
export function buildCsvDigest(text: string): CsvDigest {
  const { rows, truncated } = parseCsv(text, CSV_MAX_ROWS + 1)
  const header = rows[0] ?? []
  const dataRows = rows.slice(1, 1 + CSV_MAX_ROWS)
  const columns = header.slice(0, MAX_COLUMNS).map((c, i) => clip(c) || `column_${i + 1}`)

  // Per-column numeric stats (only columns that are predominantly numeric).
  const numericSummary: Record<string, NumericSummary> = {}
  const numericByIndex = new Map<number, NumericSummary>()
  for (let c = 0; c < columns.length; c++) {
    let count = 0
    let nonEmpty = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let sum = 0
    for (const row of dataRows) {
      const raw = (row[c] ?? '').trim()
      if (raw === '') continue
      nonEmpty++
      const n = parseNumericCell(raw)
      if (n === null) continue
      count++
      if (n < min) min = n
      if (n > max) max = n
      sum += n
    }
    if (count > 0 && count * 2 >= nonEmpty) {
      const summary = { count, min: tidy(min), max: tidy(max), sum: tidy(sum) }
      const key = columns[c] as string
      numericSummary[key] = summary
      numericByIndex.set(c, summary)
    }
  }

  // Per-asset totals when an asset-like column is recognizable.
  const assetCol = columns.findIndex((c) => ASSET_COLUMN_RE.test(c.toLowerCase()))
  const qtyCol = columns.findIndex(
    (c, i) => numericByIndex.has(i) && QUANTITY_COLUMN_RE.test(c.toLowerCase()),
  )
  let assetTotals: AssetTotal[] | null = null
  if (assetCol !== -1) {
    const groups = new Map<string, { rows: number; qty: number; hasQty: boolean }>()
    for (const row of dataRows) {
      const asset = clip(row[assetCol] ?? '')
      if (!asset) continue
      const entry = groups.get(asset) ?? { rows: 0, qty: 0, hasQty: false }
      entry.rows++
      if (qtyCol !== -1) {
        const n = parseNumericCell((row[qtyCol] ?? '').trim())
        if (n !== null) {
          entry.qty += n
          entry.hasQty = true
        }
      }
      groups.set(asset, entry)
    }
    assetTotals = [...groups.entries()]
      .sort((a, b) => b[1].rows - a[1].rows)
      .slice(0, MAX_ASSET_GROUPS)
      .map(([asset, g]) => ({
        asset,
        rows: g.rows,
        ...(g.hasQty ? { totalQuantity: tidy(g.qty) } : {}),
      }))
    if (assetTotals.length === 0) assetTotals = null
  }

  return {
    columns,
    rowCount: dataRows.length,
    truncated,
    numericSummary,
    assetTotals,
    sampleRows: dataRows
      .slice(0, MAX_SAMPLE_ROWS)
      .map((row) => row.slice(0, MAX_COLUMNS).map(clip)),
  }
}
