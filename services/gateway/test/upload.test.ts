/** File upload pipeline: POST /v1/uplink/file — auth, size caps, type
 * routing, the received→analyzing→brief frame sequence, and the failed path.
 * The intelligence /v1/analyze-file call is stubbed (recorded per test). */
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { RespondResult } from '../src/orchestrator/intelligence.js'
import type { FileAnalysisClient, FileAnalysisRequest } from '../src/upload/analysis.js'
import { buildCsvDigest, parseCsv } from '../src/upload/csv.js'
import { briefFixture, createSession, sendTurn, testApp, waitForJournal } from './helpers.js'

/** Recording stub for the intelligence file-analysis endpoint. */
function stubAnalysis(
  result: RespondResult | (() => Promise<RespondResult>) = briefFixture,
): FileAnalysisClient & { requests: FileAnalysisRequest[] } {
  const requests: FileAnalysisRequest[] = []
  return {
    requests,
    async analyzeFile(req) {
      requests.push(req)
      return typeof result === 'function' ? result() : result
    },
  }
}

const CSV_TEXT = [
  'asset,qty,price',
  'BTC,0.5,61240',
  'BTC,1.0,60800',
  'ETH,10,3400',
  '"SOL, wrapped","2",180',
].join('\n')

function b64(text: string | Buffer): string {
  return (typeof text === 'string' ? Buffer.from(text, 'utf8') : text).toString('base64')
}

async function uploadFile(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({ method: 'POST', url: '/v1/uplink/file', payload })
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> }
}

describe('upload: auth & validation', () => {
  it('rejects a malformed body with 400', async () => {
    const { app, sessions } = await testApp({ fileAnalysis: stubAnalysis() })
    const session = await createSession(app, sessions)
    const res = await uploadFile(app, { sessionId: session.id, name: 'a.csv' }) // no mime/data
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('rejects an unknown session with 404 (same auth as /v1/turns)', async () => {
    const { app } = await testApp({ fileAnalysis: stubAnalysis() })
    const res = await uploadFile(app, {
      sessionId: 's_nosuch',
      name: 'a.csv',
      mime: 'text/csv',
      dataBase64: b64('a,b\n1,2'),
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('rejects invalid base64 with 400', async () => {
    const { app, sessions } = await testApp({ fileAnalysis: stubAnalysis() })
    const session = await createSession(app, sessions)
    const res = await uploadFile(app, {
      sessionId: session.id,
      name: 'a.csv',
      mime: 'text/csv',
      dataBase64: '!!!not-base64!!!',
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('upload: type routing & size caps (soft failures — frames, not 4xx)', () => {
  it('rejects an unsupported type via a failed frame + 200 ack', async () => {
    const analysis = stubAnalysis()
    const { app, sessions } = await testApp({ fileAnalysis: analysis })
    const session = await createSession(app, sessions)
    const res = await uploadFile(app, {
      sessionId: session.id,
      name: 'report.pdf',
      mime: 'application/pdf',
      dataBase64: b64('%PDF-1.7 fake'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body.accepted).toBe(false)
    expect(String(res.body.reason)).toMatch(/unsupported/i)
    const frames = session.journal.after(0).map((e) => e.frame)
    const failed = frames.find((f) => f.type === 'upload_status') as {
      phase: string
      reason?: string
    }
    expect(failed.phase).toBe('failed')
    expect(failed.reason).toMatch(/unsupported/i)
    expect(analysis.requests).toHaveLength(0) // never reached intelligence
    await app.close()
  })

  it('rejects a CSV over 512KB decoded', async () => {
    const analysis = stubAnalysis()
    const { app, sessions } = await testApp({ fileAnalysis: analysis })
    const session = await createSession(app, sessions)
    const big = `a,b\n${'x,y\n'.repeat(140_000)}` // > 512KB
    const res = await uploadFile(app, {
      sessionId: session.id,
      name: 'big.csv',
      mime: 'text/csv',
      dataBase64: b64(big),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body.accepted).toBe(false)
    expect(String(res.body.reason)).toMatch(/512 KB/)
    const failed = session.journal.after(0).find((e) => e.frame.type === 'upload_status')
      ?.frame as { phase: string; reason?: string }
    expect(failed.phase).toBe('failed')
    expect(analysis.requests).toHaveLength(0)
    await app.close()
  })

  it('rejects an image over 3MB decoded', async () => {
    const analysis = stubAnalysis()
    const { app, sessions } = await testApp({ fileAnalysis: analysis })
    const session = await createSession(app, sessions)
    const res = await uploadFile(app, {
      sessionId: session.id,
      name: 'chart.png',
      mime: 'image/png',
      dataBase64: b64(Buffer.alloc(3 * 1024 * 1024 + 1)),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body.accepted).toBe(false)
    expect(String(res.body.reason)).toMatch(/3 MB/)
    expect(analysis.requests).toHaveLength(0)
    await app.close()
  })
})

describe('upload: CSV pipeline', () => {
  it('runs received → analyzing → research_brief with a parsed digest', async () => {
    const analysis = stubAnalysis()
    const { app, sessions } = await testApp({ fileAnalysis: analysis })
    const session = await createSession(app, sessions)
    const res = await uploadFile(app, {
      sessionId: session.id,
      name: 'holdings.csv',
      mime: 'text/csv',
      dataBase64: b64(CSV_TEXT),
    })
    expect(res.statusCode).toBe(202)
    expect(String(res.body.fileId)).toMatch(/^u_/)

    await waitForJournal(session, (t) => t.includes('research_brief'))
    const frames = session.journal.after(0).map((e) => e.frame)
    // Only the TERMINAL upload_status is journaled — 'received'/'analyzing' are
    // transient (live socket only), so a resume replay carries just 'analyzed'.
    const phases = frames
      .filter((f) => f.type === 'upload_status')
      .map((f) => (f as { phase: string }).phase)
    expect(phases).toEqual(['analyzed'])
    const statusFrame = frames.find((f) => f.type === 'upload_status') as {
      fileId: string
      name: string
      sizeDisplay: string
    }
    expect(statusFrame.fileId).toBe(res.body.fileId)
    expect(statusFrame.name).toBe('holdings.csv')
    expect(statusFrame.sizeDisplay).toMatch(/B$/)

    // The brief lands as a normal research_brief (guardrail-shaped answer).
    const brief = frames.find((f) => f.type === 'research_brief') as {
      eyebrow: string
      headline: string
      model?: string
      liveBar?: { refreshable: boolean }
    }
    expect(brief.eyebrow).toBe('FILE ANALYSIS')
    expect(brief.headline).toBe(briefFixture.headline)
    expect(brief.model).toBe(briefFixture.model)
    expect(brief.liveBar?.refreshable).toBe(false)

    // Intelligence saw the DIGEST, never the raw bytes.
    expect(analysis.requests).toHaveLength(1)
    const req = analysis.requests[0]
    if (req?.kind !== 'csv') throw new Error('expected a csv analysis request')
    expect(req.digest.columns).toEqual(['asset', 'qty', 'price'])
    expect(req.digest.rowCount).toBe(4)
    expect(req.digest.assetTotals).toEqual([
      { asset: 'BTC', rows: 2, totalQuantity: 1.5 },
      { asset: 'ETH', rows: 1, totalQuantity: 10 },
      { asset: 'SOL, wrapped', rows: 1, totalQuantity: 2 },
    ])
    await app.close()
  })

  it('routes a .csv name with a generic mime as CSV', async () => {
    const analysis = stubAnalysis()
    const { app, sessions } = await testApp({ fileAnalysis: analysis })
    const session = await createSession(app, sessions)
    await uploadFile(app, {
      sessionId: session.id,
      name: 'trades.CSV',
      mime: 'application/vnd.ms-excel',
      dataBase64: b64('a,b\n1,2'),
    })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    expect(analysis.requests[0]?.kind).toBe('csv')
    await app.close()
  })

  it('emits advice_decline when the guardrail declines a file answer', async () => {
    const analysis = stubAnalysis({
      kind: 'decline',
      message: 'no calls',
      pivotTitle: 'facts',
      facts: [{ icon: '◎', text: 'a fact' }],
      followups: [],
    })
    const { app, sessions } = await testApp({ fileAnalysis: analysis })
    const session = await createSession(app, sessions)
    await uploadFile(app, {
      sessionId: session.id,
      name: 'holdings.csv',
      mime: 'text/csv',
      dataBase64: b64(CSV_TEXT),
    })
    const types = await waitForJournal(session, (t) => t.includes('advice_decline'))
    expect(types).not.toContain('research_brief')
    await app.close()
  })

  it('closes with a failed frame when analysis is unreachable', async () => {
    const analysis = stubAnalysis(async () => {
      throw new Error('intelligence unreachable')
    })
    const { app, sessions } = await testApp({ fileAnalysis: analysis })
    const session = await createSession(app, sessions)
    await uploadFile(app, {
      sessionId: session.id,
      name: 'holdings.csv',
      mime: 'text/csv',
      dataBase64: b64(CSV_TEXT),
    })
    // Only the terminal 'failed' is journaled (received/analyzing are transient).
    await waitForJournal(session, (t) => t.includes('upload_status'))
    const phases = session.journal
      .after(0)
      .filter((e) => e.frame.type === 'upload_status')
      .map((e) => (e.frame as unknown as { phase: string }).phase)
    expect(phases).toEqual(['failed'])
    await app.close()
  })
})

describe('upload: image pipeline', () => {
  it('routes png/jpeg/webp to a vision analysis request', async () => {
    const analysis = stubAnalysis()
    const { app, sessions } = await testApp({ fileAnalysis: analysis })
    const session = await createSession(app, sessions)
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const res = await uploadFile(app, {
      sessionId: session.id,
      name: 'chart.png',
      mime: 'image/PNG',
      dataBase64: b64(bytes),
    })
    expect(res.statusCode).toBe(202)
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const req = analysis.requests[0]
    if (req?.kind !== 'image') throw new Error('expected an image analysis request')
    expect(req.mime).toBe('image/png') // normalized
    expect(req.dataBase64).toBe(b64(bytes)) // bytes pass through untouched
    await app.close()
  })
})

/** GET the "Files" library for a session. */
async function listFiles(
  app: FastifyInstance,
  sessionId: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({ method: 'GET', url: `/v1/uplink/files?session=${sessionId}` })
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> }
}

type ListedFile = {
  fileId: string
  name: string
  sizeDisplay: string
  mime: string
  kind: string
  status: string
  reason?: string
  summary?: string
  createdAt: number
}

describe('upload: files library (GET /v1/uplink/files)', () => {
  it('404s an unknown session (same auth as the upload POST)', async () => {
    const { app } = await testApp({ fileAnalysis: stubAnalysis() })
    const res = await listFiles(app, 's_nosuch')
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('records an accepted upload and lists it as analyzed with a summary', async () => {
    const { app, sessions } = await testApp({ fileAnalysis: stubAnalysis() })
    const session = await createSession(app, sessions)
    const up = await uploadFile(app, {
      sessionId: session.id,
      name: 'holdings.csv',
      mime: 'text/csv',
      dataBase64: b64(CSV_TEXT),
    })
    await waitForJournal(session, (t) => t.includes('research_brief'))
    const res = await listFiles(app, session.id)
    expect(res.statusCode).toBe(200)
    const files = res.body.files as ListedFile[]
    expect(files).toHaveLength(1)
    expect(files[0]?.fileId).toBe(up.body.fileId)
    expect(files[0]?.name).toBe('holdings.csv')
    expect(files[0]?.kind).toBe('csv')
    expect(files[0]?.status).toBe('analyzed')
    // Summary excerpts the brief (headline first).
    expect(files[0]?.summary).toContain(briefFixture.headline)
    await app.close()
  })

  it('records a failed analysis with its reason', async () => {
    const analysis = stubAnalysis(async () => {
      throw new Error('intelligence unreachable')
    })
    const { app, sessions } = await testApp({ fileAnalysis: analysis })
    const session = await createSession(app, sessions)
    await uploadFile(app, {
      sessionId: session.id,
      name: 'holdings.csv',
      mime: 'text/csv',
      dataBase64: b64(CSV_TEXT),
    })
    await waitForJournal(session, (t) => t.includes('upload_status'))
    const files = (await listFiles(app, session.id)).body.files as ListedFile[]
    expect(files[0]?.status).toBe('failed')
    expect(files[0]?.reason).toMatch(/temporarily unavailable/i)
    expect(files[0]?.summary).toBeUndefined()
    await app.close()
  })

  it('lists newest first and caps the result', async () => {
    const { app, sessions } = await testApp({ fileAnalysis: stubAnalysis() })
    const session = await createSession(app, sessions)
    for (const name of ['first.csv', 'second.csv', 'third.csv']) {
      await uploadFile(app, {
        sessionId: session.id,
        name,
        mime: 'text/csv',
        dataBase64: b64(CSV_TEXT),
      })
      // Distinct createdAt ordering (Date.now() has ms granularity).
      await new Promise((r) => setTimeout(r, 3))
    }
    await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length >= 3)
    const files = (await listFiles(app, session.id)).body.files as ListedFile[]
    expect(files.map((f) => f.name)).toEqual(['third.csv', 'second.csv', 'first.csv'])
    await app.close()
  })

  it('lists by the EFFECTIVE userKey — a claimed identity sees its own files, not the sub’s', async () => {
    const { app, sessions } = await testApp({ fileAnalysis: stubAnalysis() })
    const session = await createSession(app, sessions)
    // Anonymous upload (keyed by the session id / sub).
    await uploadFile(app, {
      sessionId: session.id,
      name: 'anon.csv',
      mime: 'text/csv',
      dataBase64: b64(CSV_TEXT),
    })
    await waitForJournal(session, (t) => t.includes('research_brief'))

    // Claim an identity — the effective userKey flips to id:<username>.
    await sendTurn(app, session.id, {
      kind: 'identity_claim',
      mode: 'create',
      username: 'victor',
      pin: '4321',
    })
    await waitForJournal(session, (t) => t.filter((x) => x === 'identity').length >= 1)

    // The library now reflects the identity — it has no files yet.
    let files = (await listFiles(app, session.id)).body.files as ListedFile[]
    expect(files).toHaveLength(0)

    // A new upload under the identity is listed for the identity.
    await uploadFile(app, {
      sessionId: session.id,
      name: 'id.csv',
      mime: 'text/csv',
      dataBase64: b64(CSV_TEXT),
    })
    await waitForJournal(session, (t) => t.filter((x) => x === 'research_brief').length >= 2)
    files = (await listFiles(app, session.id)).body.files as ListedFile[]
    expect(files.map((f) => f.name)).toEqual(['id.csv'])
    await app.close()
  })
})

describe('upload: csv parser & digest', () => {
  it('handles quoted fields, escaped quotes and CRLF', () => {
    const { rows } = parseCsv('a,"b ""x"", y",c\r\n1,"2,2",3\r\n', 100)
    expect(rows).toEqual([
      ['a', 'b "x", y', 'c'],
      ['1', '2,2', '3'],
    ])
  })

  it('caps rows and marks the digest truncated', () => {
    const text = `n\n${Array.from({ length: 2500 }, (_, i) => String(i)).join('\n')}`
    const digest = buildCsvDigest(text)
    expect(digest.rowCount).toBe(2000)
    expect(digest.truncated).toBe(true)
  })

  it('summarizes numeric columns and skips non-numeric ones', () => {
    const digest = buildCsvDigest('asset,qty,note\nBTC,1.5,hello\nETH,"2,000",world')
    expect(digest.numericSummary.qty).toEqual({ count: 2, min: 1.5, max: 2000, sum: 2001.5 })
    expect(digest.numericSummary.note).toBeUndefined()
    expect(digest.sampleRows).toEqual([
      ['BTC', '1.5', 'hello'],
      ['ETH', '2,000', 'world'],
    ])
  })

  it('returns null assetTotals when no asset-like column exists', () => {
    const digest = buildCsvDigest('foo,bar\n1,2')
    expect(digest.assetTotals).toBeNull()
  })
})
