import { describe, expect, it } from 'vitest'
import { CanonicalOrder, Frame, parseFrame, Uplink, VenueCapabilities } from '../src/index.js'

const base = { v: 1 as const, id: 'f_1', ts: 1_752_480_000_000 }

describe('card protocol v1 — frames', () => {
  it('parses a research_brief', () => {
    const result = parseFrame({
      ...base,
      type: 'research_brief',
      eyebrow: 'MARKET BRIEF',
      live: true,
      headline: 'BTC is down 4.2% over 12 hours',
      paragraphs: ['US inflation came in hotter than expected…'],
      stats: [
        { k: 'LAST', v: '61,240' },
        { k: '12H', v: '−4.2%', tone: 'neg' },
      ],
      spark: { points: [11, 8, 15, 13, 26, 35, 41] },
      sources: ['PRICE FEED', 'FUNDING', 'NEWS ×2'],
      liveBar: { asOf: 'AS OF 14:32:05 IST', asOfIso: '2026-07-14T09:02:05Z' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.frame.type).toBe('research_brief')
  })

  it('parses an order_ticket with display-string rows', () => {
    const result = parseFrame({
      ...base,
      type: 'order_ticket',
      ticketId: 't_1',
      side: 'buy',
      sideLabel: 'BUY · MKT',
      rows: [
        { label: 'Instrument', value: 'BTC / USDT' },
        { label: 'Est. cost incl. fees', value: '3,068.30 USDT' },
      ],
      cta: 'Review & confirm in Assetworks →',
      footnote: 'Hippo prepared this order. Assetworks will ask you to confirm.',
    })
    expect(result.ok).toBe(true)
  })

  it('parses a brief_delta (streaming research prose)', () => {
    const result = parseFrame({
      ...base,
      type: 'brief_delta',
      text: 'BTC is down 4.2% after the ',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.frame.type).toBe('brief_delta')
  })

  it('routes unknown future card types to the fallback path, never a throw', () => {
    const result = parseFrame({
      ...base,
      type: 'watchlist_card',
      fallback: { text: 'Your watchlist is ready.' },
      anything: { nested: true },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.unknown).not.toBeNull()
      expect(result.unknown?.fallback?.text).toBe('Your watchlist is ready.')
    }
  })

  it('drops garbage silently (no throw on any wire bytes)', () => {
    expect(parseFrame('not json{{{').ok).toBe(false)
    expect(parseFrame(42).ok).toBe(false)
    expect(parseFrame(null).ok).toBe(false)
    expect(parseFrame({ type: 'research_brief' }).ok).toBe(false) // missing envelope
  })

  it('parses an interpretation frame — persistent understanding card', () => {
    const result = parseFrame({
      ...base,
      type: 'interpretation',
      summary: 'Understood: is BTC a buy? → advice-bait → decline with facts',
      intent: 'advice',
      memoryScopes: ['platform', 'user'],
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.frame.type === 'interpretation') {
      expect(result.frame.summary).toContain('BTC')
      expect(result.frame.memoryScopes).toEqual(['platform', 'user'])
    }
  })

  it('interpretation frame defaults memoryScopes to [] and tolerates missing intent', () => {
    const result = parseFrame({ ...base, type: 'interpretation', summary: 'ok' })
    expect(result.ok).toBe(true)
    if (result.ok && result.frame.type === 'interpretation') {
      expect(result.frame.memoryScopes).toEqual([])
      expect(result.frame.intent).toBeUndefined()
    }
  })

  it('rejects a lifecycle frame with an invalid phase', () => {
    const bad = Frame.safeParse({
      ...base,
      type: 'lifecycle',
      ticketId: 't_1',
      phase: 'teleported',
      statusLine: 'x',
    })
    expect(bad.success).toBe(false)
  })

  it('parses a bare lifecycle frame — old gateways send no stage/side', () => {
    const result = parseFrame({
      ...base,
      type: 'lifecycle',
      ticketId: 't_1',
      phase: 'awaiting_confirm',
      statusLine: 'WAITING FOR YOUR CONFIRM ON THE VENUE',
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.frame.type === 'lifecycle') {
      expect(result.frame.stage).toBeUndefined()
      expect(result.frame.side).toBeUndefined()
    }
  })

  it('parses lifecycle progress fields — stage, side, fillPct', () => {
    const result = parseFrame({
      ...base,
      type: 'lifecycle',
      ticketId: 't_1',
      phase: 'partial',
      stage: 'working',
      side: 'buy',
      fillPct: 40,
      statusLine: 'PARTIALLY FILLED',
      rows: [{ label: 'Filled', value: '0.02 / 0.05' }],
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.frame.type === 'lifecycle') {
      expect(result.frame.stage).toBe('working')
      expect(result.frame.side).toBe('buy')
      expect(result.frame.fillPct).toBe(40)
    }
  })

  it('accepts an UNKNOWN stage string — open vocabulary, future servers may grow it', () => {
    const result = parseFrame({
      ...base,
      type: 'lifecycle',
      ticketId: 't_1',
      phase: 'awaiting_confirm',
      stage: 'venue_review',
      statusLine: 'UNDER REVIEW ON THE VENUE',
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.frame.type === 'lifecycle') {
      expect(result.frame.stage).toBe('venue_review')
    }
  })

  it('rejects an invalid side — closed set, mirrors order_ticket', () => {
    const bad = Frame.safeParse({
      ...base,
      type: 'lifecycle',
      ticketId: 't_1',
      phase: 'filled',
      side: 'hold',
      statusLine: 'FILLED',
    })
    expect(bad.success).toBe(false)
  })

  it('strips unknown lifecycle keys — a newer server never breaks this schema', () => {
    const result = parseFrame({
      ...base,
      type: 'lifecycle',
      ticketId: 't_1',
      phase: 'filled',
      statusLine: 'FILLED',
      futureField: { anything: true },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect('futureField' in result.frame).toBe(false)
  })
})

describe('card protocol v1 — uplinks', () => {
  it('parses feedback with pre-categorized eval reason', () => {
    const up = Uplink.safeParse({
      v: 1,
      sessionId: 's_1',
      ts: Date.now(),
      kind: 'feedback',
      frameId: 'f_9',
      vote: 'down',
      reason: 'too_shallow',
    })
    expect(up.success).toBe(true)
  })

  it('parses stream_stop (base envelope only — no payload)', () => {
    const up = Uplink.safeParse({
      v: 1,
      sessionId: 's_1',
      ts: Date.now(),
      kind: 'stream_stop',
    })
    expect(up.success).toBe(true)
  })

  it('rejects stream_stop without the base envelope', () => {
    const up = Uplink.safeParse({ kind: 'stream_stop' })
    expect(up.success).toBe(false)
  })

  it('caps user text at 2000 chars', () => {
    const up = Uplink.safeParse({
      v: 1,
      sessionId: 's_1',
      ts: Date.now(),
      kind: 'user_text',
      text: 'x'.repeat(2001),
    })
    expect(up.success).toBe(false)
  })
})

describe('Phase B — learned_memory frame + clearLearnedMemory (additive)', () => {
  it('parses a learned_memory frame with user + session facts', () => {
    const r = Frame.safeParse({
      ...base,
      type: 'learned_memory',
      facts: [
        { label: 'Follows BTC', type: 'followed_asset', value: 'BTC', scope: 'user' },
        { label: 'Prefers perps', type: 'instrument_pref', value: 'perps', scope: 'session' },
      ],
    })
    expect(r.success).toBe(true)
  })

  it('defaults facts to [] and rejects an unknown scope', () => {
    expect(Frame.safeParse({ ...base, type: 'learned_memory' }).success).toBe(true)
    const bad = Frame.safeParse({
      ...base,
      type: 'learned_memory',
      facts: [{ label: 'x', type: 't', value: 'v', scope: 'global' }],
    })
    expect(bad.success).toBe(false)
  })

  it('accepts clearLearnedMemory on the settings uplink', () => {
    const up = Uplink.safeParse({
      v: 1,
      sessionId: 's_1',
      ts: 1_752_480_000_000,
      kind: 'settings',
      clearLearnedMemory: true,
    })
    expect(up.success).toBe(true)
  })

  it('Phase C: learned_memory carries optIn (defaults true) + settings accepts learnedMemoryOptIn', () => {
    // optIn defaults true when omitted
    const f = Frame.safeParse({ ...base, type: 'learned_memory' })
    expect(f.success && f.data.type === 'learned_memory' && f.data.optIn).toBe(true)
    // explicit false round-trips
    const f2 = Frame.safeParse({ ...base, type: 'learned_memory', optIn: false })
    expect(f2.success && f2.data.type === 'learned_memory' && f2.data.optIn).toBe(false)
    // the toggle uplink
    const up = Uplink.safeParse({
      v: 1,
      sessionId: 's_1',
      ts: 1_752_480_000_000,
      kind: 'settings',
      learnedMemoryOptIn: false,
    })
    expect(up.success).toBe(true)
  })
})

describe('interactive order card — order_draft / price_tick / draft_action / context (additive)', () => {
  it('parses a full perp order_draft with control bounds', () => {
    const r = Frame.safeParse({
      ...base,
      type: 'order_draft',
      draftId: 'd_1',
      capability: 'futures_perp',
      title: 'Set up your LONG BTC order',
      instrument: 'BTC/USDT',
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      side: 'buy',
      direction: 'long',
      size: '0.5',
      sizeAsset: 'BTC',
      orderType: 'market',
      leverage: 10,
      maxLeverage: 50,
      marginMode: 'isolated',
      marginModes: ['isolated', 'cross'],
      cta: 'Review order →',
    })
    expect(r.success).toBe(true)
  })

  it('spot draft needs no perp fields; size defaults empty (trader fills it)', () => {
    const r = Frame.safeParse({
      ...base,
      type: 'order_draft',
      draftId: 'd_2',
      capability: 'spot',
      title: 'Set up your BUY BTC order',
      instrument: 'BTC/USDT',
      side: 'buy',
      sizeAsset: 'BTC',
      cta: 'Review order →',
    })
    expect(r.success && r.data.type === 'order_draft' && r.data.size).toBe('')
  })

  it('parses a price_tick and rejects a non-numeric last', () => {
    const ok = Frame.safeParse({
      ...base,
      type: 'price_tick',
      symbol: 'BTC/USDT',
      last: 63631.63,
      lastDisplay: '63,631.63',
      asOfIso: '2026-07-28T09:00:00.000Z',
    })
    expect(ok.success).toBe(true)
    const bad = Frame.safeParse({
      ...base,
      type: 'price_tick',
      symbol: 'BTC/USDT',
      last: '63631',
      lastDisplay: '63,631',
      asOfIso: '2026-07-28T09:00:00.000Z',
    })
    expect(bad.success).toBe(false)
  })

  it('draft_action submit carries edited params; dismiss needs none', () => {
    const submit = Uplink.safeParse({
      v: 1,
      sessionId: 's_1',
      ts: 1_752_480_000_000,
      kind: 'draft_action',
      draftId: 'd_1',
      action: 'submit',
      params: {
        instrument: 'ETH/USDT',
        orderType: 'limit',
        size: '1.5',
        limitPrice: '1850',
        leverage: 20,
        marginMode: 'cross',
      },
    })
    expect(submit.success).toBe(true)
    const dismiss = Uplink.safeParse({
      v: 1,
      sessionId: 's_1',
      ts: 1_752_480_000_000,
      kind: 'draft_action',
      draftId: 'd_1',
      action: 'dismiss',
    })
    expect(dismiss.success).toBe(true)
    // empty size on submit params is rejected — the control enforces it too
    const empty = Uplink.safeParse({
      v: 1,
      sessionId: 's_1',
      ts: 1_752_480_000_000,
      kind: 'draft_action',
      draftId: 'd_1',
      action: 'submit',
      params: { instrument: 'BTC/USDT', orderType: 'market', size: '' },
    })
    expect(empty.success).toBe(false)
  })

  it('context uplink carries the host page symbol', () => {
    const up = Uplink.safeParse({
      v: 1,
      sessionId: 's_1',
      ts: 1_752_480_000_000,
      kind: 'context',
      symbol: 'ETH/USDT',
    })
    expect(up.success).toBe(true)
  })
})

describe('dynamic features — identity / upload_status / identity_claim (additive)', () => {
  it('parses identity frames for ok and non-ok states', () => {
    const ok = Frame.safeParse({ ...base, type: 'identity', status: 'ok', username: 'victor_t' })
    expect(ok.success).toBe(true)
    const bad = Frame.safeParse({ ...base, type: 'identity', status: 'banana' })
    expect(bad.success).toBe(false)
  })

  it('parses upload_status phases and rejects unknown phases', () => {
    const ok = Frame.safeParse({
      ...base,
      type: 'upload_status',
      fileId: 'f_1',
      name: 'portfolio.csv',
      sizeDisplay: '184 KB',
      phase: 'analyzing',
    })
    expect(ok.success).toBe(true)
    const bad = Frame.safeParse({
      ...base,
      type: 'upload_status',
      fileId: 'f_1',
      name: 'x',
      sizeDisplay: '1 KB',
      phase: 'uploading',
    })
    expect(bad.success).toBe(false) // client-side byte progress never crosses the wire
  })

  it('identity_claim validates username charset and 4-digit pin; signout needs neither', () => {
    const mk = (extra: object) =>
      Uplink.safeParse({
        v: 1,
        sessionId: 's_1',
        ts: 1_752_480_000_000,
        kind: 'identity_claim',
        ...extra,
      })
    expect(mk({ mode: 'create', username: 'victor_t', pin: '4821' }).success).toBe(true)
    expect(mk({ mode: 'signin', username: 'victor_t', pin: '4821' }).success).toBe(true)
    expect(mk({ mode: 'signout' }).success).toBe(true)
    expect(mk({ mode: 'create', username: 'no spaces!', pin: '4821' }).success).toBe(false)
    expect(mk({ mode: 'signin', username: 'victor_t', pin: '48213' }).success).toBe(false)
    expect(mk({ mode: 'signin', username: 'victor_t', pin: 'abcd' }).success).toBe(false)
  })
})

describe('host interaction — host_action / orders_summary / context.pageControl (additive)', () => {
  it('parses host_action for the legacy chart verbs and bounds the open verb string', () => {
    const tf = Frame.safeParse({
      ...base,
      type: 'host_action',
      actionId: 'ha_1',
      action: 'set_timeframe',
      timeframe: '5m',
      note: 'Chart → 5m',
    })
    expect(tf.success).toBe(true)
    const ind = Frame.safeParse({
      ...base,
      type: 'host_action',
      actionId: 'ha_2',
      action: 'apply_indicator',
      indicator: 'rsi',
    })
    expect(ind.success).toBe(true)
    // action is an open STRING (stage precedent) — bounded, never empty
    const empty = Frame.safeParse({ ...base, type: 'host_action', actionId: 'ha_3', action: '' })
    expect(empty.success).toBe(false)
    const tooLong = Frame.safeParse({
      ...base,
      type: 'host_action',
      actionId: 'ha_3b',
      action: 'x'.repeat(41),
    })
    expect(tooLong.success).toBe(false)
    const badTf = Frame.safeParse({
      ...base,
      type: 'host_action',
      actionId: 'ha_4',
      action: 'set_timeframe',
      timeframe: '7m',
    })
    expect(badTf.success).toBe(false)
    const badInd = Frame.safeParse({
      ...base,
      type: 'host_action',
      actionId: 'ha_5',
      action: 'apply_indicator',
      indicator: 'RSI overlay!',
    })
    expect(badInd.success).toBe(false) // indicator is a strict slug — no free text toward the host
  })

  it('parses orders_summary with scope, totals and open-string statuses', () => {
    const ok = Frame.safeParse({
      ...base,
      type: 'orders_summary',
      scope: 'session',
      asOfIso: '2026-07-31T05:00:00Z',
      orders: [
        {
          orderId: 'o_1',
          symbol: 'BTC/USDT',
          side: 'buy',
          kind: 'LMT 60,000',
          qty: '0.3',
          price: '60,000',
          status: 'WORKING',
          filledPct: 40,
        },
        {
          orderId: 'o_2',
          symbol: 'ETH/USDT',
          side: 'sell',
          kind: 'MKT',
          qty: '1',
          status: 'FILLED',
        },
      ],
      totals: { open: 1, filled: 1, cancelled: 0 },
    })
    expect(ok.success).toBe(true)
    const badScope = Frame.safeParse({
      ...base,
      type: 'orders_summary',
      scope: 'today',
      asOfIso: '2026-07-31T05:00:00Z',
      orders: [],
      totals: { open: 0, filled: 0, cancelled: 0 },
    })
    expect(badScope.success).toBe(false)
  })

  it('context uplink carries the optional pageControl opt-in', () => {
    const mk = (extra: object) =>
      Uplink.safeParse({ v: 1, sessionId: 's_1', ts: 1_752_480_000_000, kind: 'context', ...extra })
    expect(mk({ symbol: 'BTC/USDT', pageControl: true }).success).toBe(true)
    expect(mk({}).success).toBe(true) // still valid without it — additive
    expect(mk({ pageControl: 'yes' }).success).toBe(false)
  })
})

describe('wave 2 — host verbs / alerts / protective exits (additive)', () => {
  const upBase = { v: 1 as const, sessionId: 's_1', ts: 1_752_480_000_000 }

  it('BACK-COMPAT: old-style host_action (former enum value, no params) still parses', () => {
    const r = parseFrame({
      ...base,
      type: 'host_action',
      actionId: 'ha_old',
      action: 'remove_indicator',
      indicator: 'rsi',
    })
    expect(r.ok).toBe(true)
    if (r.ok && r.frame.type === 'host_action') {
      expect(r.frame.action).toBe('remove_indicator')
      expect(r.frame.params).toBeUndefined()
    }
  })

  it('host_action accepts new open verbs with params', () => {
    const nav = Frame.safeParse({
      ...base,
      type: 'host_action',
      actionId: 'ha_nav',
      action: 'navigate',
      params: { target: '/futures/BTC-USDT' },
      note: 'Opening futures →',
    })
    expect(nav.success).toBe(true)
    const prefill = Frame.safeParse({
      ...base,
      type: 'host_action',
      actionId: 'ha_pf',
      action: 'prefill_ticket',
      params: { symbol: 'ETH/USDT', side: 'buy', size: '1.5' },
    })
    expect(prefill.success).toBe(true)
  })

  it('rejects an oversized host_action params map (entries, key length, value length)', () => {
    const mk = (params: Record<string, string>) =>
      Frame.safeParse({
        ...base,
        type: 'host_action',
        actionId: 'ha_p',
        action: 'navigate',
        params,
      })
    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']))
    expect(mk(tooMany).success).toBe(false)
    expect(mk({ ['k'.repeat(41)]: 'v' }).success).toBe(false)
    expect(mk({ target: 'v'.repeat(201) }).success).toBe(false)
    expect(mk({ target: '/spot' }).success).toBe(true)
  })

  it('context uplink declares supported host verbs; pageControl alone stays legacy', () => {
    const mk = (extra: object) => Uplink.safeParse({ ...upBase, kind: 'context', ...extra })
    expect(
      mk({ pageControl: true, hostActions: ['set_timeframe', 'navigate', 'prefill_ticket'] })
        .success,
    ).toBe(true)
    expect(mk({ pageControl: true }).success).toBe(true) // legacy chart verbs only
    expect(mk({ hostActions: [] }).success).toBe(true)
    expect(mk({ hostActions: ['', 'navigate'] }).success).toBe(false) // no empty verbs
    expect(mk({ hostActions: Array.from({ length: 25 }, (_, i) => `verb_${i}`) }).success).toBe(
      false,
    ) // bounded list
  })

  it('parses an alert frame in every state and renders conditionLabel verbatim', () => {
    for (const state of ['armed', 'triggered', 'cancelled'] as const) {
      const r = parseFrame({
        ...base,
        type: 'alert',
        alertId: 'a_1',
        symbol: 'BTC/USDT',
        conditionLabel: 'ABOVE 70,000',
        state,
        tsIso: '2026-08-01T09:00:00Z',
        fallback: { text: 'Alert ABOVE 70,000 on BTC/USDT.' },
      })
      expect(r.ok).toBe(true)
      if (r.ok && r.frame.type === 'alert') {
        expect(r.frame.conditionLabel).toBe('ABOVE 70,000')
        expect(r.frame.state).toBe(state)
      }
    }
  })

  it('rejects an alert with a bad state enum or missing conditionLabel', () => {
    const badState = Frame.safeParse({
      ...base,
      type: 'alert',
      alertId: 'a_1',
      symbol: 'BTC/USDT',
      conditionLabel: 'ABOVE 70,000',
      state: 'snoozed',
    })
    expect(badState.success).toBe(false)
    const noLabel = Frame.safeParse({
      ...base,
      type: 'alert',
      alertId: 'a_1',
      symbol: 'BTC/USDT',
      state: 'armed',
    })
    expect(noLabel.success).toBe(false)
  })

  it('alert_action uplink cancels; creation has no wire verb', () => {
    const cancel = Uplink.safeParse({
      ...upBase,
      kind: 'alert_action',
      alertId: 'a_1',
      action: 'cancel',
    })
    expect(cancel.success).toBe(true)
    const create = Uplink.safeParse({
      ...upBase,
      kind: 'alert_action',
      alertId: 'a_1',
      action: 'create',
    })
    expect(create.success).toBe(false) // creation is conversational (user_text)
    const noId = Uplink.safeParse({ ...upBase, kind: 'alert_action', action: 'cancel' })
    expect(noId.success).toBe(false)
  })

  it('order_draft round-trips stop-loss / take-profit as strings; numbers are rejected', () => {
    const draft = {
      ...base,
      type: 'order_draft',
      draftId: 'd_3',
      capability: 'futures_perp',
      title: 'Set up your LONG BTC order',
      instrument: 'BTC/USDT',
      side: 'buy',
      direction: 'long',
      sizeAsset: 'BTC',
      cta: 'Review order →',
      stopLossPrice: '58,000',
      takeProfitPrice: '72,000',
    }
    const ok = Frame.safeParse(draft)
    expect(ok.success).toBe(true)
    if (ok.success && ok.data.type === 'order_draft') {
      expect(ok.data.stopLossPrice).toBe('58,000')
      expect(ok.data.takeProfitPrice).toBe('72,000')
    }
    expect(Frame.safeParse({ ...draft, stopLossPrice: 58000 }).success).toBe(false)
    expect(Frame.safeParse({ ...draft, takeProfitPrice: 72000 }).success).toBe(false)
  })

  it('draft_action submit echoes SL/TP strings; non-string prices are rejected', () => {
    const mk = (params: object) =>
      Uplink.safeParse({
        ...upBase,
        kind: 'draft_action',
        draftId: 'd_3',
        action: 'submit',
        params: { instrument: 'BTC/USDT', orderType: 'market', size: '0.5', ...params },
      })
    expect(mk({ stopLossPrice: '58,000', takeProfitPrice: '72,000' }).success).toBe(true)
    expect(mk({}).success).toBe(true) // both optional — additive
    expect(mk({ stopLossPrice: 58000 }).success).toBe(false)
  })

  it('canonical orders carry optional SL/TP strings; venue caps gate via protectiveExits presence', () => {
    const spot = CanonicalOrder.safeParse({
      capability: 'spot',
      instrument: 'BTC/USDT',
      side: 'buy',
      size: '0.5',
      orderType: 'market',
      stopLossPrice: '58,000',
    })
    expect(spot.success).toBe(true)
    const perp = CanonicalOrder.safeParse({
      capability: 'futures_perp',
      instrument: 'BTC/USDT',
      direction: 'long',
      leverage: 10,
      marginMode: 'isolated',
      size: '0.5',
      orderType: 'market',
      takeProfitPrice: '72,000',
    })
    expect(perp.success).toBe(true)
    const badPerp = CanonicalOrder.safeParse({
      capability: 'futures_perp',
      instrument: 'BTC/USDT',
      direction: 'long',
      leverage: 10,
      marginMode: 'isolated',
      size: '0.5',
      orderType: 'market',
      stopLossPrice: 58000,
    })
    expect(badPerp.success).toBe(false) // money is a STRING, never a number
    // presence-pattern: protectiveExits is literal true or absent, never false
    expect(
      VenueCapabilities.safeParse({
        spot: { protectiveExits: true },
        futures_perp: { maxLeverage: 50, marginModes: ['isolated'], protectiveExits: true },
      }).success,
    ).toBe(true)
    expect(VenueCapabilities.safeParse({ spot: {} }).success).toBe(true) // absent = disabled
    expect(VenueCapabilities.safeParse({ spot: { protectiveExits: false } }).success).toBe(false)
  })
})
