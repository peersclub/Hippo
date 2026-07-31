/**
 * Host page-control actions — the SDK side of the postMessage bridge the
 * gateway uses to drive the host page's chart ("switch to 5m", "apply RSI").
 *
 * The SDK NEVER touches the host DOM. On a `host_action` frame it forwards a
 * validated message to the host page (the pinned SDK↔host contract, matched
 * verbatim by host-demo #76), arms a short ack timeout, and reflects the
 * outcome on an in-thread chip:
 *
 *   SDK → host:  { source:'hippo-sdk',  type:'hippo:action',        actionId, action, timeframe?, indicator? }
 *   host → SDK:  { source:'hippo-host', type:'hippo:action:result', actionId, ok, reason? }
 *
 * Chip lifecycle: pending → applied (ok) / failed (ok:false) / timeout (no ack
 * within HOST_ACTION_TIMEOUT_MS). The state map is a signal (not card
 * component state) so the outcome survives minimize/reopen, exactly like
 * feedbackMap. A host that never opted in simply never receives host_action
 * frames, so this code never runs for it.
 */

import type { HostAction } from '@hippo/protocol'
import { signal } from '@preact/signals'

export type HostActionPhase = 'pending' | 'applied' | 'failed' | 'timeout'
export type HostActionState = { phase: HostActionPhase; reason?: string }

/** Chip state per host_action, keyed by actionId. */
export const hostActionMap = signal<Record<string, HostActionState>>({})

/** How long to wait for the host's ack before declaring "no response from
 * page". Deliberately short — a chart control that took the page seconds to
 * apply is a failure the trader should see, not an indefinite spinner. */
export const HOST_ACTION_TIMEOUT_MS = 3000

/** Live ack timers, keyed by actionId — cleared on ack, deleted on fire. */
const timers: Record<string, ReturnType<typeof setTimeout>> = {}

function setState(actionId: string, s: HostActionState) {
  hostActionMap.value = { ...hostActionMap.value, [actionId]: s }
}

/** The message the SDK posts to the host page for one action. Only the fields
 * the host validates ride along; the server-authored `note` stays SDK-side (it
 * drives the chip, not the host's chart). */
export function actionMessage(frame: HostAction): {
  source: 'hippo-sdk'
  type: 'hippo:action'
  actionId: string
  action: HostAction['action']
  timeframe?: string
  indicator?: string
} {
  return {
    source: 'hippo-sdk',
    type: 'hippo:action',
    actionId: frame.actionId,
    action: frame.action,
    ...(frame.timeframe ? { timeframe: frame.timeframe } : {}),
    ...(frame.indicator ? { indicator: frame.indicator } : {}),
  }
}

/**
 * Forward a host_action to the host page and arm the ack timeout. Idempotent
 * per actionId — a journal replay after a reconnect must not re-post an action
 * the host already applied (and can't reset a settled chip). Never throws: a
 * blocked postMessage must not wedge the chip on `pending`.
 */
export function forwardHostAction(frame: HostAction): void {
  if (hostActionMap.value[frame.actionId]) return
  setState(frame.actionId, { phase: 'pending' })
  try {
    if (typeof window !== 'undefined') {
      window.postMessage(actionMessage(frame), window.location.origin)
    }
  } catch {
    // Untrusted host environment — never let a post failure break the panel.
  }
  timers[frame.actionId] = setTimeout(() => {
    delete timers[frame.actionId]
    // Only a still-pending action times out; a landed ack already won.
    if (hostActionMap.value[frame.actionId]?.phase === 'pending') {
      setState(frame.actionId, { phase: 'timeout' })
    }
  }, HOST_ACTION_TIMEOUT_MS)
}

export type HostAck = { actionId: string; ok: boolean; reason?: string }

/**
 * Validate one raw window message as a host ack. Returns the normalized ack or
 * null for anything that isn't a well-formed hippo:action:result — wrong
 * source/type, missing/mistyped actionId or ok. Same strict-shape posture as
 * the context bridge: one bad field rejects the whole message.
 */
export function parseAck(data: unknown): HostAck | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  if (d.source !== 'hippo-host' || d.type !== 'hippo:action:result') return null
  if (typeof d.actionId !== 'string' || d.actionId.length === 0) return null
  if (typeof d.ok !== 'boolean') return null
  if (d.reason !== undefined && typeof d.reason !== 'string') return null
  return { actionId: d.actionId, ok: d.ok, reason: d.reason as string | undefined }
}

/**
 * Accept an ack only from the expected host origin AND when it's well-formed.
 * The origin gate mirrors how the host re-validates origin on its side of the
 * bridge (exchange.js drops any message whose origin isn't its own).
 */
export function acceptAck(origin: string, expectedOrigin: string, data: unknown): HostAck | null {
  if (origin !== expectedOrigin) return null
  return parseAck(data)
}

/**
 * Apply a validated ack to the chip. Only a `pending` action settles — a late
 * ack after timeout, a duplicate, or an ack for an action we never sent is
 * ignored, so the first terminal outcome wins (like the feedback reducer).
 */
export function applyAck(ack: HostAck): void {
  if (hostActionMap.value[ack.actionId]?.phase !== 'pending') return
  const timer = timers[ack.actionId]
  if (timer !== undefined) {
    clearTimeout(timer)
    delete timers[ack.actionId]
  }
  setState(ack.actionId, ack.ok ? { phase: 'applied' } : { phase: 'failed', reason: ack.reason })
}
