/**
 * edit-velocity.test.js — typing-speed heuristic (src/content/edit-velocity.js)
 */

import { describe, it, expect } from 'vitest'
import {
  createVelocityTracker,
  velocityFrom,
  isTooFastForHuman,
  HUMAN_CPM_CEILING,
} from '../src/content/edit-velocity.js'

describe('velocityFrom', () => {
  it('computes chars/min from produced keys over active time', () => {
    // 5 produced keys over 2s active = 150 cpm
    expect(velocityFrom(5, 2000)).toBe(150)
  })

  it('returns null with fewer than two produced keys', () => {
    expect(velocityFrom(1, 1000)).toBeNull()
  })

  it('returns null with no active time (no divide-by-zero)', () => {
    expect(velocityFrom(5, 0)).toBeNull()
  })
})

describe('createVelocityTracker — pause handling', () => {
  it('excludes long pauses from active typing time', () => {
    const t = createVelocityTracker()
    // Three quick keys (100ms apart) then a 60s pause then two more quick keys.
    t.record(false, 0)
    t.record(false, 100)
    t.record(false, 200)
    t.record(false, 60_200) // 60s pause — must NOT count
    t.record(false, 60_300)
    const s = t.summary()
    // The 60s pause is excluded: active time is just the 4 small gaps (~300ms),
    // far below a single PAUSE_GAP_MS — this is the core pause-handling proof.
    expect(s.active_ms).toBe(300)
    expect(s.produced_keys).toBe(5)
    // Without pause exclusion this would be ~5 cpm (5 keys / 60s); with it, the
    // rate reflects the actual fast cadence instead.
    expect(s.chars_per_min).toBe(1000)
  })

  it('a steady human cadence reads as a human rate', () => {
    const t = createVelocityTracker()
    // 6 keys, 250ms apart = 5 gaps * 250ms = 1250ms active -> 6/1250*60000 = 288
    for (let i = 0; i < 6; i++) t.record(false, i * 250)
    const cpm = t.summary().chars_per_min
    expect(cpm).toBe(288)
    expect(isTooFastForHuman(cpm)).toBe(false)
  })
})

describe('createVelocityTracker — churn (delete/backspace)', () => {
  it('counts deletes separately and not as produced characters', () => {
    const t = createVelocityTracker()
    t.record(false, 0)    // type
    t.record(false, 200)  // type
    t.record(true, 400)   // backspace
    t.record(true, 600)   // backspace
    const s = t.summary()
    expect(s.produced_keys).toBe(2)
    expect(s.churn_keys).toBe(2)
  })

  it('pure deletes never produce a forward velocity', () => {
    const t = createVelocityTracker()
    t.record(true, 0)
    t.record(true, 200)
    expect(t.summary().chars_per_min).toBeNull()
  })
})

describe('isTooFastForHuman', () => {
  it('flags bursts above the ceiling', () => {
    expect(isTooFastForHuman(6000)).toBe(true)
  })
  it('does not flag the ceiling exactly (strictly greater)', () => {
    expect(isTooFastForHuman(HUMAN_CPM_CEILING)).toBe(false)
  })
  it('treats null (not measured) as not flagged', () => {
    expect(isTooFastForHuman(null)).toBe(false)
  })
})
