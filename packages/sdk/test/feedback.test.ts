import { describe, expect, it } from 'vitest'
import {
  FEEDBACK_REASONS,
  type FeedbackState,
  feedbackDoneLabel,
  feedbackTransition,
} from '../src/feedback.js'

const idle: FeedbackState = { phase: 'idle' }

describe('feedback state machine', () => {
  it('👍 thanks instantly and sends the vote', () => {
    const t = feedbackTransition(idle, { type: 'vote', vote: 'up' })
    expect(t.state).toEqual({ phase: 'thanked' })
    expect(t.uplink).toEqual({ vote: 'up' })
    expect(feedbackDoneLabel(t.state)).toBe('THANKS')
  })

  it('👎 sends the vote-only uplink immediately, then asks', () => {
    const t = feedbackTransition(idle, { type: 'vote', vote: 'down' })
    expect(t.state).toEqual({ phase: 'asking' })
    expect(t.uplink).toEqual({ vote: 'down' })
  })

  it('a reason chip sends a SECOND uplink carrying the reason', () => {
    const asking = feedbackTransition(idle, { type: 'vote', vote: 'down' }).state
    const t = feedbackTransition(asking, { type: 'reason', reason: 'too_shallow' })
    expect(t.state).toEqual({ phase: 'noted', withReason: true })
    expect(t.uplink).toEqual({ vote: 'down', reason: 'too_shallow' })
    expect(feedbackDoneLabel(t.state)).toBe('NOTED — THANKS')
  })

  it('skip dismisses without sending anything further', () => {
    const asking = feedbackTransition(idle, { type: 'vote', vote: 'down' }).state
    const t = feedbackTransition(asking, { type: 'skip' })
    expect(t.state).toEqual({ phase: 'noted', withReason: false })
    expect(t.uplink).toBeUndefined()
    expect(feedbackDoneLabel(t.state)).toBe('NOTED')
  })

  it('terminal states ignore further events — feedback is one-shot', () => {
    for (const state of [
      { phase: 'thanked' },
      { phase: 'noted', withReason: true },
    ] as FeedbackState[]) {
      const t = feedbackTransition(state, { type: 'vote', vote: 'down' })
      expect(t.state).toBe(state)
      expect(t.uplink).toBeUndefined()
    }
  })

  it('reason/skip in idle are no-ops (never sent before a vote)', () => {
    expect(feedbackTransition(idle, { type: 'reason', reason: 'outdated' }).uplink).toBeUndefined()
    expect(feedbackTransition(idle, { type: 'skip' }).state).toEqual(idle)
  })

  it('reasons map 1:1 to the protocol enum (eval-harness criteria)', () => {
    expect(FEEDBACK_REASONS.map((r) => r.reason)).toEqual(['inaccurate', 'too_shallow', 'outdated'])
  })
})
