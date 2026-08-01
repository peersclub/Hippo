import { afterEach, describe, expect, it } from 'vitest'
import {
  ALERT_STATE_KEY,
  alertStateClass,
  cancelAlertUplink,
  showCancelChip,
} from '../src/alerts-view.js'
import { t } from '../src/i18n.js'
import { pushFrame, thread } from '../src/state.js'
import { clearStreamWatchdog } from '../src/streaming.js'

afterEach(() => {
  clearStreamWatchdog()
  thread.value = []
})

const base = { v: 1 as const, ts: 1 }

const alertFrame = (
  id: string,
  alertId: string,
  state: 'armed' | 'triggered' | 'cancelled',
  extra: Record<string, unknown> = {},
) => ({
  ...base,
  id,
  type: 'alert' as const,
  alertId,
  symbol: 'BTC/USDT',
  conditionLabel: 'BTC/USDT ABOVE 70,000',
  state,
  ...extra,
})

describe('alert state presentation', () => {
  it('maps each state to its badge label key (chrome, localized ×4)', () => {
    expect(ALERT_STATE_KEY.armed).toBe('alert_state_armed')
    expect(ALERT_STATE_KEY.triggered).toBe('alert_state_triggered')
    expect(ALERT_STATE_KEY.cancelled).toBe('alert_state_cancelled')
    // Every locale carries the alert chrome (Catalog typing enforces the
    // rest; spot-check that translations exist and differ where expected).
    for (const locale of ['en', 'hi', 'hi-Latn', 'ar'] as const) {
      expect(t(locale, 'alert_eyebrow').length).toBeGreaterThan(0)
      expect(t(locale, 'alert_cancel').length).toBeGreaterThan(0)
    }
    expect(t('hi', 'alert_cancel')).not.toBe(t('en', 'alert_cancel'))
    expect(t('ar', 'alert_cancel')).not.toBe(t('en', 'alert_cancel'))
  })

  it('state class mirrors the wire state 1:1 (armed pulse / triggered accent / cancelled dim)', () => {
    expect(alertStateClass('armed')).toBe('armed')
    expect(alertStateClass('triggered')).toBe('triggered')
    expect(alertStateClass('cancelled')).toBe('cancelled')
  })

  it('offers CANCEL only on armed cards', () => {
    expect(showCancelChip('armed')).toBe(true)
    expect(showCancelChip('triggered')).toBe(false)
    expect(showCancelChip('cancelled')).toBe(false)
  })

  it('builds the exact alert_action cancel uplink', () => {
    expect(cancelAlertUplink('al_abc')).toEqual({
      kind: 'alert_action',
      alertId: 'al_abc',
      action: 'cancel',
    })
  })
})

describe('thread collapse by alertId', () => {
  it('a state change updates the existing card in place — one card per alert', () => {
    pushFrame({ kind: 'frame', frame: alertFrame('f1', 'al_1', 'armed') as never })
    pushFrame({
      kind: 'frame',
      frame: alertFrame('f2', 'al_1', 'triggered', { note: 'Triggered at 70,012' }) as never,
    })

    const alerts = thread.value.filter((x) => x.kind === 'frame' && x.frame.type === 'alert')
    expect(alerts).toHaveLength(1)
    const frame = (alerts[0] as { frame: { state: string; note?: string } }).frame
    expect(frame.state).toBe('triggered')
    expect(frame.note).toBe('Triggered at 70,012')
  })

  it('distinct alerts stack as distinct cards', () => {
    pushFrame({ kind: 'frame', frame: alertFrame('f1', 'al_1', 'armed') as never })
    pushFrame({ kind: 'frame', frame: alertFrame('f2', 'al_2', 'armed') as never })
    expect(thread.value.filter((x) => x.kind === 'frame' && x.frame.type === 'alert')).toHaveLength(
      2,
    )
  })

  it('re-emitting an armed card (the "which alert?" listing) never duplicates it', () => {
    pushFrame({ kind: 'frame', frame: alertFrame('f1', 'al_1', 'armed') as never })
    pushFrame({ kind: 'frame', frame: alertFrame('f2', 'al_1', 'armed') as never })
    expect(thread.value.filter((x) => x.kind === 'frame' && x.frame.type === 'alert')).toHaveLength(
      1,
    )
  })

  it('an alert frame clears a trailing thinking/skeleton like any content', () => {
    pushFrame({
      kind: 'frame',
      frame: { ...base, id: 'sk', type: 'skeleton' as const, shape: 'brief' } as never,
    })
    pushFrame({ kind: 'frame', frame: alertFrame('f1', 'al_1', 'armed') as never })
    expect(thread.value.map((x) => (x.kind === 'frame' ? x.frame.type : '?'))).toEqual(['alert'])
  })
})
