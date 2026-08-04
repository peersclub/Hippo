import type { Clarification, Uplink } from '@hippo/protocol'
import type { VNode } from 'preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The card's option chips ride transport `send` (live-only, like ticket and
// alert actions). Mocked so a tap is observable without a gateway.
const sent: Array<Partial<Uplink>> = []
let sendResult = true
vi.mock('../src/transport.js', () => ({
  gatewayUrl: () => null,
  connect: async () => {},
  send: async (u: Partial<Uplink>) => {
    sent.push(u)
    return sendResult
  },
}))

const { renderFrame } = await import('../src/cards.js')
const {
  chosenOptionId,
  clarificationChoiceUplink,
  clarificationMap,
  clarificationState,
  isAnswerable,
  pickOption,
} = await import('../src/clarification.js')
const { connection } = await import('../src/state.js')

/** Flatten a rendered vnode tree to its text + the buttons it drew. Cards are
 * pure (props in, DOM out) and this card uses no hooks, so the component can
 * be invoked directly — no DOM needed to assert what it renders. */
function renderCard(f: Clarification): { text: string; buttons: VNode[] } {
  const el = renderFrame(f) as VNode<{ frame: Clarification }> | null
  if (!el) throw new Error('clarification rendered nothing')
  const tree = (el.type as (p: { frame: Clarification }) => VNode)({ frame: f })
  const text: string[] = []
  const buttons: VNode[] = []
  const walk = (node: unknown): void => {
    if (node === null || node === undefined || node === false || node === true) return
    if (Array.isArray(node)) {
      for (const n of node) walk(n)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      text.push(String(node))
      return
    }
    const vnode = node as VNode<Record<string, unknown>>
    if (vnode.type === 'button') buttons.push(vnode)
    walk((vnode.props as { children?: unknown } | null)?.children)
  }
  walk(tree)
  return { text: text.join(' '), buttons }
}

/** Fire the nth option button's click handler. */
function tap(buttons: VNode[], index: number): void {
  const button = buttons[index]
  if (!button) throw new Error(`no option button at index ${index}`)
  const onClick = (button.props as { onClick?: () => void }).onClick
  if (!onClick) throw new Error('option button has no click handler')
  onClick()
}

const frame = (): Clarification => ({
  id: 'f_1',
  v: 1,
  seq: 1,
  ts: 0,
  type: 'clarification',
  clarificationId: 'c_1',
  question: 'Before I touch an order — which did you mean?',
  options: [
    { id: 'as_asked', label: 'Close your BTC position (market)', hint: 'You review and confirm.' },
    { id: 'show_orders', label: 'Show me my orders first', hint: 'Nothing is placed.' },
  ],
  originalText: 'close btc',
  note: "I'd rather ask than guess. Nothing was sent to Assetworks.",
})

beforeEach(() => {
  clarificationMap.value = {}
  sent.length = 0
  sendResult = true
  connection.value = 'live'
})

describe('clarificationChoiceUplink', () => {
  it('carries ids only — every display string was server-authored', () => {
    expect(clarificationChoiceUplink('c_1', 'as_asked')).toEqual({
      kind: 'clarification_choice',
      clarificationId: 'c_1',
      optionId: 'as_asked',
    })
  })
})

describe('pickOption', () => {
  it('sends the uplink for the tapped option and settles the card', async () => {
    const send = vi.fn(async () => true)
    expect(await pickOption('c_1', 'as_asked', send)).toBe('sent')
    expect(send).toHaveBeenCalledWith({
      kind: 'clarification_choice',
      clarificationId: 'c_1',
      optionId: 'as_asked',
    })
    expect(clarificationState('c_1')).toEqual({ phase: 'picked', optionId: 'as_asked' })
    expect(isAnswerable(clarificationState('c_1'))).toBe(false)
    expect(chosenOptionId(clarificationState('c_1'))).toBe('as_asked')
  })

  it('settles ONCE — a second tap sends nothing', async () => {
    const send = vi.fn(async () => true)
    await pickOption('c_1', 'as_asked', send)
    expect(await pickOption('c_1', 'show_orders', send)).toBe('ignored')
    expect(send).toHaveBeenCalledTimes(1)
    // The first pick stands; the second never overwrote it.
    expect(chosenOptionId(clarificationState('c_1'))).toBe('as_asked')
  })

  it('ignores a tap while a send is still in flight', async () => {
    let release: (ok: boolean) => void = () => {}
    const slow = vi.fn(() => new Promise<boolean>((r) => (release = r)))
    const first = pickOption('c_1', 'as_asked', slow)
    expect(await pickOption('c_1', 'show_orders', slow)).toBe('ignored')
    release(true)
    expect(await first).toBe('sent')
    expect(slow).toHaveBeenCalledTimes(1)
  })

  it('a send that never lands leaves the question answerable — never stranded', async () => {
    expect(await pickOption('c_1', 'as_asked', async () => false)).toBe('failed')
    expect(clarificationState('c_1')).toEqual({ phase: 'failed' })
    expect(isAnswerable(clarificationState('c_1'))).toBe(true)
    // …and the retry goes through.
    const send = vi.fn(async () => true)
    expect(await pickOption('c_1', 'as_asked', send)).toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('treats a throwing transport as a failure, never an unhandled rejection', async () => {
    expect(
      await pickOption('c_1', 'as_asked', async () => {
        throw new Error('network')
      }),
    ).toBe('failed')
    expect(clarificationState('c_1')).toEqual({ phase: 'failed' })
  })
})

describe('clarification card', () => {
  // renderFrame's switch ends `default: return null`, so an unhandled
  // clarification would render NOTHING — the trader would see a question that
  // never arrived. This is the regression guard for that.
  it('renders a card for the clarification frame', () => {
    expect(renderFrame(frame())).not.toBeNull()
  })

  it('draws the question, the trader’s own words, and every option verbatim', () => {
    const f = frame()
    const { text, buttons } = renderCard(f)
    expect(text).toContain(f.question)
    expect(text).toContain('close btc')
    expect(text).toContain(f.note ?? '')
    expect(buttons.length).toBe(f.options.length)
    for (const o of f.options) {
      expect(text).toContain(o.label)
      if (o.hint) expect(text).toContain(o.hint)
    }
  })

  it('does not look like an answer — its own eyebrow, never brief chrome', () => {
    const { text } = renderCard(frame())
    expect(text).toContain('BEFORE I ACT')
    expect(text).not.toContain('MARKET BRIEF')
  })

  it('an option tap sends the clarification_choice uplink for that option', async () => {
    const f = frame()
    const { buttons } = renderCard(f)
    tap(buttons, 1)
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0]).toEqual({
      kind: 'clarification_choice',
      clarificationId: 'c_1',
      optionId: 'show_orders',
    })
  })

  it('settles after the pick — the chosen label reads back, no options remain', async () => {
    const f = frame()
    tap(renderCard(f).buttons, 0)
    await vi.waitFor(() => expect(sent.length).toBe(1))

    const settled = renderCard(f)
    expect(settled.buttons.length).toBe(0)
    expect(settled.text).toContain('Close your BTC position (market)')
    expect(settled.text).toContain('YOU CHOSE')
  })

  it('disables the options while the panel is offline, and says why', () => {
    connection.value = 'offline'
    const { buttons } = renderCard(frame())
    for (const b of buttons) {
      const props = b.props as { disabled?: boolean; title?: string }
      expect(props.disabled).toBe(true)
      expect(props.title).toBe('Reconnect to answer this')
    }
  })
})
