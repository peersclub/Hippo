import { describe, expect, it } from 'vitest'
import {
  CSV_MAX_BYTES,
  checkUpload,
  dataUrlToBase64,
  formatBytes,
  IMAGE_MAX_BYTES,
  progressPct,
  uploadMime,
} from '../src/upload.js'

// The client-side gate runs BEFORE a single byte is sent — an unsupported or
// oversized file surfaces a local error and never leaves the panel.
describe('checkUpload — the pinned contract limits', () => {
  it('accepts a CSV up to exactly 512KB, by mime or extension', () => {
    expect(checkUpload('trades.csv', 'text/csv', CSV_MAX_BYTES)).toEqual({ ok: true, kind: 'csv' })
    // Browsers report vendor/empty mimes for CSV — the extension is a
    // first-class signal.
    expect(checkUpload('trades.CSV', 'application/vnd.ms-excel', 10)).toEqual({
      ok: true,
      kind: 'csv',
    })
    expect(checkUpload('trades.csv', '', 10)).toEqual({ ok: true, kind: 'csv' })
  })

  it('rejects a CSV one byte over the limit', () => {
    expect(checkUpload('trades.csv', 'text/csv', CSV_MAX_BYTES + 1)).toEqual({
      ok: false,
      reason: 'too_large_csv',
    })
  })

  it('accepts png/jpeg/webp up to exactly 3MB', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(checkUpload('chart.bin', mime, IMAGE_MAX_BYTES)).toEqual({ ok: true, kind: 'image' })
    }
    expect(checkUpload('chart.jpg', '', 10)).toEqual({ ok: true, kind: 'image' })
  })

  it('rejects an image one byte over the limit', () => {
    expect(checkUpload('chart.png', 'image/png', IMAGE_MAX_BYTES + 1)).toEqual({
      ok: false,
      reason: 'too_large_image',
    })
  })

  it('rejects every other type as unsupported — never sent', () => {
    expect(checkUpload('report.pdf', 'application/pdf', 10)).toEqual({
      ok: false,
      reason: 'unsupported',
    })
    expect(checkUpload('notes.txt', 'text/plain', 10)).toEqual({ ok: false, reason: 'unsupported' })
    expect(checkUpload('anim.gif', 'image/gif', 10)).toEqual({ ok: false, reason: 'unsupported' })
    expect(checkUpload('noext', '', 10)).toEqual({ ok: false, reason: 'unsupported' })
  })
})

describe('formatBytes — client progress row label (bytes, never money)', () => {
  it('picks the human unit', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(184 * 1024)).toBe('184 KB')
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })
})

describe('progressPct', () => {
  it('clamps to 0–100 integers and treats unknown totals as 0', () => {
    expect(progressPct(0, 100)).toBe(0)
    expect(progressPct(50, 200)).toBe(25)
    expect(progressPct(200, 100)).toBe(100)
    expect(progressPct(10, 0)).toBe(0)
  })
})

describe('dataUrlToBase64', () => {
  it('strips the FileReader data-URL prefix', () => {
    expect(dataUrlToBase64('data:text/csv;base64,QSxC')).toBe('QSxC')
  })
  it('passes bare base64 through', () => {
    expect(dataUrlToBase64('QSxC')).toBe('QSxC')
  })
})

describe('uploadMime — the contract body mime', () => {
  it("uses the browser's mime when it gave one", () => {
    expect(uploadMime('csv', 'application/vnd.ms-excel')).toBe('application/vnd.ms-excel')
  })
  it('derives a sensible default for mime-less CSVs', () => {
    expect(uploadMime('csv', '')).toBe('text/csv')
    expect(uploadMime('image', '')).toBe('application/octet-stream')
  })
})
