/**
 * OpenTelemetry instrumentation (C2). In-memory metric + span exporters — no
 * collector. Asserts the four rate-card instruments emit with the right names
 * and attributes, both when driven directly and end-to-end through a turn.
 */
import { metrics, trace } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  type MetricData,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Telemetry } from '../src/plugins/telemetry.js'
import { createSession, sendTurn, stubIntel, testApp, waitForJournal } from './helpers.js'

function meterHarness() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })
  const provider = new MeterProvider({ readers: [reader] })
  return { meter: provider.getMeter('test'), provider, exporter }
}

async function collect(
  provider: MeterProvider,
  exporter: InMemoryMetricExporter,
): Promise<Map<string, MetricData>> {
  await provider.forceFlush()
  const byName = new Map<string, MetricData>()
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) byName.set(m.descriptor.name, m)
    }
  }
  return byName
}

describe('OTel instruments (direct)', () => {
  it('emits the four rate-card instruments with the right names/attributes', async () => {
    const { meter, provider, exporter } = meterHarness()
    const telemetry = new Telemetry({ meter })

    telemetry.recordIntent('research', 12)
    telemetry.recordFirstToken(340, 'research')
    telemetry.recordCache(true)
    telemetry.recordCache(false)
    telemetry.recordAdvice(true)

    const metricsByName = await collect(provider, exporter)

    // 1. intent p95
    const intent = metricsByName.get('hippo.intent.classification.duration')
    expect(intent).toBeDefined()
    expect(intent?.dataPoints[0]?.attributes).toMatchObject({ intent: 'research' })

    // 2. first-token p95
    const firstToken = metricsByName.get('hippo.first_token.duration')
    expect(firstToken).toBeDefined()
    expect(firstToken?.dataPoints[0]?.attributes).toMatchObject({ intent: 'research' })

    // 3. answer-cache hit rate — one hit, one miss.
    const cache = metricsByName.get('hippo.answer_cache.requests')
    expect(cache).toBeDefined()
    const results = cache?.dataPoints.map((d) => d.attributes.result).sort()
    expect(results).toEqual(['hit', 'miss'])

    // 4. advice-decline rate
    const advice = metricsByName.get('hippo.advice.turns')
    expect(advice).toBeDefined()
    expect(advice?.dataPoints[0]?.attributes).toMatchObject({ outcome: 'declined' })
  })

  it('opens a turn span with the resolved intent as an attribute', () => {
    const spanExporter = new InMemorySpanExporter()
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    })
    const telemetry = new Telemetry({ tracer: tracerProvider.getTracer('test') })

    const span = telemetry.startSpan('hippo.turn', { 'hippo.intent': 'advice' })
    span.end()

    const finished = spanExporter.getFinishedSpans()
    expect(finished).toHaveLength(1)
    expect(finished[0]?.name).toBe('hippo.turn')
    expect(finished[0]?.attributes).toMatchObject({ 'hippo.intent': 'advice' })
  })
})

describe('OTel instruments (through a turn)', () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })
  const provider = new MeterProvider({ readers: [reader] })

  beforeAll(() => {
    // buildApp's Telemetry reads the global meter — register ours first.
    metrics.setGlobalMeterProvider(provider)
  })
  afterAll(() => {
    metrics.disable()
    trace.disable()
  })

  it('records intent duration, first token and cache result on a research turn', async () => {
    const { app, sessions } = await testApp()
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'why is btc down' })
    await waitForJournal(session, (t) => t.includes('research_brief'))

    const byName = await collect(provider, exporter)
    expect(byName.get('hippo.intent.classification.duration')).toBeDefined()
    expect(byName.get('hippo.first_token.duration')).toBeDefined()
    const cache = byName.get('hippo.answer_cache.requests')
    // briefFixture is cached:false → one miss recorded.
    expect(cache?.dataPoints.some((d) => d.attributes.result === 'miss')).toBe(true)
    await app.close()
  })

  it('records an advice decline on an advice turn', async () => {
    const intel = stubIntel({
      intent: () => ({ intent: 'advice', confidence: 0.95, language: 'en' }),
      respond: () => ({
        kind: 'decline',
        message: 'no advice',
        pivotTitle: 'facts',
        facts: [],
        followups: [],
      }),
    })
    const { app, sessions } = await testApp({ intel })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'should i buy btc?' })
    await waitForJournal(session, (t) => t.includes('advice_decline'))

    const byName = await collect(provider, exporter)
    const advice = byName.get('hippo.advice.turns')
    expect(advice?.dataPoints.some((d) => d.attributes.outcome === 'declined')).toBe(true)
    await app.close()
  })
})
