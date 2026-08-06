/**
 * Venue capability truth on EVERY order path.
 *
 * Why this file exists: every capability stub in order-draft.test.ts
 * advertises both spot and futures_perp, so no test ever exercised a
 * single-capability venue — and three defects shipped behind that gap.
 *
 *   1. A perp ask on a spot-only venue was silently rewritten to spot: "long
 *      0.5 BTC 20x" rendered "Set up your BUY BTC order", no leverage, no
 *      mention that perps aren't supported.
 *   2. A spot draft on a perp-only venue prepared happily and only failed at
 *      confirm, where the real reason was discarded into a generic hand-off
 *      failure.
 *   3. The leverage/marginMode bound check lived in submitDraft, so it covered
 *      the DRAFT path only. Close, fractional-close and amend bypassed it —
 *      and the intelligence fast-path hardcodes leverage 10 for fractional
 *      closes, so "close half my BTC long" on a 5×-max venue rendered a ticket
 *      reading CLOSE LONG 10× with margin derived from a fabricated number.
 *
 * The distinction that makes all of this safe: FETCHED capabilities are venue
 * truth and are enforced; an UNREACHABLE seam yields a lenient fallback and
 * the turn still flows (the seam re-validates downstream, authoritatively).
 * The last case here pins that leniency so a later tightening can't regress it.
 */
import type { VenueCapabilities } from '@hippo/protocol'
import { describe, expect, it } from 'vitest'
import type { IntentResult } from '../src/orchestrator/intelligence.js'
import type { SeamClient, SeamPortfolio } from '../src/orchestrator/seam.js'
import {
  createSession,
  type DraftFrame,
  frameOfType,
  sendTurn,
  stubIntel,
  stubSeam,
  testApp,
  waitForJournal,
} from './helpers.js'

// ── capability fixtures ───────────────────────────────────────────────────

/** A spot-only venue: no perps at all. */
const SPOT_ONLY: VenueCapabilities = { spot: {} }
/** A perp-only venue: leveraged futures, no spot book. */
const PERP_ONLY: VenueCapabilities = {
  futures_perp: { maxLeverage: 20, marginModes: ['isolated', 'cross'] },
}
/** A conservative venue capping leverage at 5×. */
const LOW_LEVERAGE: VenueCapabilities = {
  spot: {},
  futures_perp: { maxLeverage: 5, marginModes: ['isolated'] },
}

// ── intent fixtures ───────────────────────────────────────────────────────

/** "long 0.5 btc 20x" — a fully-parsed leveraged perp OPEN. */
const perpOpenIntent = (leverage = 20) =>
  stubIntel({
    intent: (): IntentResult => ({
      intent: 'action',
      confidence: 0.9,
      language: 'en',
      order: {
        capability: 'futures_perp',
        side: 'buy',
        direction: 'long',
        leverage,
        marginMode: 'isolated',
        size: '0.5',
        instrument: 'BTC/USDT',
        orderType: 'market',
      },
    }),
  })

/** "buy 0.5 btc" — a plain spot OPEN, no capability tag (absent = spot). */
const spotOpenIntent = () =>
  stubIntel({
    intent: (): IntentResult => ({
      intent: 'action',
      confidence: 0.9,
      language: 'en',
      order: {
        side: 'buy',
        size: '0.5',
        instrument: 'BTC/USDT',
        orderType: 'market',
      },
    }),
  })

/** "close half my btc long" exactly as intent.py emits it — note the
 * hardcoded leverage 10 with no trader override anywhere in the phrasing. */
const fractionalCloseIntent = (fraction = 0.5) =>
  stubIntel({
    intent: (): IntentResult => ({
      intent: 'action',
      confidence: 0.95,
      language: 'en',
      order: {
        capability: 'futures_perp',
        side: 'sell',
        direction: 'long',
        action: 'close',
        leverage: 10,
        marginMode: 'isolated',
        reduceOnly: true,
        size: '',
        sizeFraction: fraction,
        instrument: 'BTC/USDT',
        orderType: 'market',
      },
    }),
  })

// ── portfolio fixtures ────────────────────────────────────────────────────

/** A LIVE perp row the way the AssetWorks adapter renders one:
 * `${pairName} ${leverage}x ${direction}`. This is where a close's leverage
 * must come from. */
const leveragedPosition = (leverage: number): SeamPortfolio => ({
  positions: [
    {
      instrument: `BTC-USDT ${leverage}x LONG`,
      size: '0.40 BTC',
      entry: '58,420',
      mark: '61,240',
      pnl: '+1,128.00 USDT',
      tone: 'pos',
    },
  ],
  openOrders: [],
})

/** A position row that advertises NO leverage (the sim venue's shape) — the
 * gateway must not invent one, and the bound check has to catch what the
 * parser guessed. */
const unlabelledPosition: SeamPortfolio = {
  positions: [
    {
      instrument: 'BTC/USDT',
      size: '0.40 BTC',
      entry: '58,420',
      mark: '61,240',
      pnl: '+1,128.00 USDT',
      tone: 'pos',
    },
  ],
  openOrders: [],
}

const frameTypes = (session: Awaited<ReturnType<typeof createSession>>) =>
  session.journal.after(0).map((e) => e.frame.type)

const rejectionReason = (session: Awaited<ReturnType<typeof createSession>>) =>
  frameOfType<{ reason: string }>(session, 'rejection_ticket').reason

// ── table 1: capability presence on the DRAFT path ────────────────────────

describe('fetched capabilities are venue truth: unsupported asks are declined, never downgraded', () => {
  const cases: Array<{
    name: string
    caps: VenueCapabilities
    intel: () => ReturnType<typeof stubIntel>
    text: string
    reason: RegExp
  }> = [
    {
      name: 'perp phrasing on a spot-only venue',
      caps: SPOT_ONLY,
      intel: () => perpOpenIntent(),
      text: 'long 0.5 btc 20x',
      reason: /doesn't support perpetual futures/i,
    },
    {
      name: 'spot phrasing on a perp-only venue',
      caps: PERP_ONLY,
      intel: spotOpenIntent,
      text: 'buy 0.5 btc',
      reason: /doesn't support spot orders/i,
    },
  ]

  for (const c of cases) {
    it(`${c.name} → rejection_ticket, no order_draft, seam.prepare never called`, async () => {
      const seam = stubSeam(c.caps)
      const { app, sessions } = await testApp({ intel: c.intel(), seam })
      const session = await createSession(app, sessions)
      await sendTurn(app, session.id, { kind: 'user_text', text: c.text })
      await waitForJournal(session, (t) => t.includes('rejection_ticket'))

      expect(rejectionReason(session)).toMatch(c.reason)
      // The whole point: no card that misrepresents what the venue will do.
      expect(frameTypes(session)).not.toContain('order_draft')
      expect(frameTypes(session)).not.toContain('order_ticket')
      expect(seam.prepares).toHaveLength(0)
      await app.close()
    })
  }

  it('spot-only venue: the declined perp ask names leverage as the thing it will not fake', async () => {
    const seam = stubSeam(SPOT_ONLY)
    const { app, sessions } = await testApp({ intel: perpOpenIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 btc 20x' })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    // The old behaviour rendered "Set up your BUY BTC order" — an unleveraged
    // spot position the trader never asked for. The copy must say why.
    expect(rejectionReason(session)).toMatch(/leveraged|perpetual futures/i)
    expect(rejectionReason(session)).toMatch(/nothing was sent to the venue/i)
    await app.close()
  })

  it('a venue WITH perps still drafts the perp normally (the gate only bites on absence)', async () => {
    const seam = stubSeam()
    const { app, sessions } = await testApp({ intel: perpOpenIntent(10), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 btc 10x' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    expect(draft.capability).toBe('futures_perp')
    expect(draft.maxLeverage).toBe(20)
    expect(frameTypes(session)).not.toContain('rejection_ticket')
    await app.close()
  })
})

// ── table 2: the bound check covers CLOSE, not just the draft path ────────

describe('leverage bounds are enforced on the close path, not only on drafts', () => {
  it("5×-max venue + fractional close carrying the parser's 10× → declined, seam.prepare never called", async () => {
    const seam = stubSeam(LOW_LEVERAGE)
    // No leverage on the row, so nothing corrects the parser's guess — the
    // hoisted bound check in prepareTicket is the only thing standing here.
    seam.portfolio = async () => unlabelledPosition
    const { app, sessions } = await testApp({ intel: fractionalCloseIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'close half my btc long' })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))

    const reason = rejectionReason(session)
    expect(reason).toMatch(/leverage/i)
    expect(reason).toContain('10')
    expect(reason).toContain('5')
    expect(seam.prepares).toHaveLength(0)
    expect(frameTypes(session)).not.toContain('order_ticket')
    await app.close()
  })

  it('margin mode outside the venue set on a close → declined before the seam', async () => {
    const seam = stubSeam({
      spot: {},
      futures_perp: { maxLeverage: 20, marginModes: ['isolated'] },
    })
    seam.portfolio = async () => leveragedPosition(5)
    const { app, sessions } = await testApp({
      intel: stubIntel({
        intent: (): IntentResult => ({
          intent: 'action',
          confidence: 0.95,
          language: 'en',
          order: {
            capability: 'futures_perp',
            side: 'sell',
            direction: 'long',
            action: 'close',
            leverage: 5,
            marginMode: 'cross',
            reduceOnly: true,
            size: '0.4',
            instrument: 'BTC/USDT',
            orderType: 'market',
          },
        }),
      }),
      seam,
    })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'close my btc long' })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    expect(rejectionReason(session)).toContain('isolated')
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })

  it('perp close on a venue with NO perps → declined (close bypassed the draft gate entirely)', async () => {
    const seam = stubSeam(SPOT_ONLY)
    seam.portfolio = async () => unlabelledPosition
    const { app, sessions } = await testApp({ intel: fractionalCloseIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'close half my btc long' })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    expect(rejectionReason(session)).toMatch(/doesn't support perpetual futures/i)
    expect(seam.prepares).toHaveLength(0)
    await app.close()
  })
})

// ── table 3: the close's leverage comes from the LIVE position ────────────

describe("a close's leverage comes from the position, never from the parser", () => {
  it('5× live position + parser-invented 10× → the plan carries 5×', async () => {
    const seam = stubSeam(LOW_LEVERAGE)
    seam.portfolio = async () => leveragedPosition(5)
    const { app, sessions } = await testApp({ intel: fractionalCloseIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'close half my btc long' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))

    const plan = seam.prepares[0] as { leverage: number; size: string; capability: string }
    expect(plan.capability).toBe('futures_perp')
    // 10× was never real. 5× is what the venue holds.
    expect(plan.leverage).toBe(5)
    // …and the fraction still resolved against the live size (0.5 × 0.40).
    expect(plan.size).toBe('0.2')
    expect(frameTypes(session)).not.toContain('rejection_ticket')
    await app.close()
  })

  it('3× live position on a 20× venue → 3×, not the venue max and not the parser default', async () => {
    const seam = stubSeam()
    seam.portfolio = async () => leveragedPosition(3)
    const { app, sessions } = await testApp({ intel: fractionalCloseIntent(1), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'close my btc long' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    const plan = seam.prepares[0] as { leverage: number; size: string }
    expect(plan.leverage).toBe(3)
    expect(plan.size).toBe('0.4')
    await app.close()
  })

  it('position row without a leverage label → the parser value is left alone for the bound check to judge', async () => {
    // Honest limitation: not every venue adapter advertises leverage on the
    // position row (the sim venue doesn't). The gateway must not invent one —
    // it forwards what it was given and lets the bounds decide. Here 10× is
    // inside the 20× venue range, so it goes through unchanged.
    const seam = stubSeam()
    seam.portfolio = async () => unlabelledPosition
    const { app, sessions } = await testApp({ intel: fractionalCloseIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'close half my btc long' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    expect((seam.prepares[0] as { leverage: number }).leverage).toBe(10)
    await app.close()
  })
})

// ── table 4: the unreachable-venue fallback stays lenient ─────────────────

describe('an UNREACHABLE seam is not venue truth — the fallback stays lenient', () => {
  /** Capabilities are hard-down; everything else on the seam works. This is
   * the `{spot:{}}` fallback path, and it must NOT be mistaken for a
   * spot-only venue. */
  const capsDownSeam = (): ReturnType<typeof stubSeam> => {
    const seam = stubSeam()
    seam.capabilities = async () => {
      throw new Error('seam capabilities unreachable')
    }
    return seam
  }

  it('perp ask with capabilities down → still drafts (degraded to spot bounds), no decline', async () => {
    const seam = capsDownSeam()
    const { app, sessions } = await testApp({ intel: perpOpenIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'long 0.5 btc 20x' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    // Pre-change behaviour, deliberately preserved: no perp bounds to offer,
    // so the card degrades rather than blocking the trader on OUR outage.
    expect(draft.capability).toBe('spot')
    expect(draft.maxLeverage).toBeUndefined()
    expect(frameTypes(session)).not.toContain('rejection_ticket')
    await app.close()
  })

  it('spot ask with capabilities down → still drafts, no "doesn\'t support spot" decline', async () => {
    const seam = capsDownSeam()
    const { app, sessions } = await testApp({ intel: spotOpenIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'buy 0.5 btc' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    expect(frameTypes(session)).not.toContain('rejection_ticket')
    await app.close()
  })

  it('close with capabilities down → prepared and forwarded, seam validates downstream', async () => {
    const seam = capsDownSeam()
    seam.portfolio = async () => leveragedPosition(5)
    const { app, sessions } = await testApp({ intel: fractionalCloseIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'close half my btc long' })
    await waitForJournal(session, (t) => t.includes('order_ticket'))
    expect(seam.prepares).toHaveLength(1)
    // The position's own leverage still wins — that fix needs no capabilities.
    expect((seam.prepares[0] as { leverage: number }).leverage).toBe(5)
    await app.close()
  })

  it('a hard-down seam (capabilities AND prepare) still rejects honestly, not silently', async () => {
    const seam: SeamClient = {
      ...stubSeam(),
      capabilities: async () => {
        throw new Error('seam unreachable')
      },
      prepare: async () => {
        throw new Error('seam unreachable')
      },
      prepareOrder: async () => {
        throw new Error('seam unreachable')
      },
    }
    const { app, sessions } = await testApp({ intel: spotOpenIntent(), seam })
    const session = await createSession(app, sessions)
    await sendTurn(app, session.id, { kind: 'user_text', text: 'buy 0.5 btc' })
    await waitForJournal(session, (t) => t.includes('order_draft'))
    const draft = frameOfType<DraftFrame>(session, 'order_draft')
    await sendTurn(app, session.id, {
      kind: 'draft_action',
      draftId: draft.draftId,
      action: 'submit',
      params: { instrument: 'BTC/USDT', orderType: 'market', size: '0.5' },
    })
    await waitForJournal(session, (t) => t.includes('rejection_ticket'))
    expect(rejectionReason(session)).toMatch(/couldn't quote this order/i)
    await app.close()
  })
})
