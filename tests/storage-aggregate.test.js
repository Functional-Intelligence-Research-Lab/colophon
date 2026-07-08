/**
 * storage-aggregate.test.js
 *
 * Tests for aggregateOldEditEvents() — the storage-quota trim logic. Never
 * deletes acceptance/provenance-bearing event types; only collapses runs of
 * plain `edit` events that fall before the most recent checkpoint.
 */
import { describe, it, expect } from 'vitest'
import { aggregateOldEditEvents } from '../src/shared/storage.js'

function edit(ts, char_delta, char_count) {
  return { timestamp: ts, type: 'edit', meta: { char_delta, char_count } }
}
function checkpoint(ts) {
  return { timestamp: ts, type: 'checkpoint', meta: { char_count_total: 100, word_count_total: 20 } }
}
function paste(ts) {
  return { timestamp: ts, type: 'paste', meta: { char_count: 50, output_preview: 'hello' } }
}

describe('aggregateOldEditEvents', () => {
  it('does nothing when there is no checkpoint', () => {
    const events = [edit('t1', 5, 5), edit('t2', 3, 3)]
    const result = aggregateOldEditEvents(events)
    expect(result.changed).toBe(false)
    expect(result.events).toEqual(events)
  })

  it('does nothing when the checkpoint is the very first event', () => {
    const events = [checkpoint('t0'), edit('t1', 5, 5), edit('t2', 3, 3)]
    const result = aggregateOldEditEvents(events)
    expect(result.changed).toBe(false)
    expect(result.events).toEqual(events)
  })

  it('collapses a run of >=2 edit events before the last checkpoint into one edit_summary', () => {
    const events = [
      edit('t1', 10, 10),
      edit('t2', -3, 3),
      edit('t3', 7, 7),
      checkpoint('t4'),
      edit('t5', 2, 2), // after the checkpoint — must stay untouched
    ]
    const result = aggregateOldEditEvents(events)
    expect(result.changed).toBe(true)
    expect(result.events).toHaveLength(3) // 1 summary + checkpoint + trailing edit
    expect(result.events[0].type).toBe('edit_summary')
    expect(result.events[0].meta.source_event_count).toBe(3)
    expect(result.events[0].meta.char_delta_sum).toBe(14) // 10 - 3 + 7
    expect(result.events[0].meta.char_count_sum).toBe(20) // 10 + 3 + 7
    expect(result.events[1].type).toBe('checkpoint')
    expect(result.events[2]).toEqual(edit('t5', 2, 2))
  })

  it('leaves a single isolated edit event alone (not worth aggregating)', () => {
    const events = [edit('t1', 5, 5), checkpoint('t2')]
    const result = aggregateOldEditEvents(events)
    expect(result.changed).toBe(false)
    expect(result.events).toEqual(events)
  })

  it('never touches ai_interaction/paste/checkpoint/session events, even between edits', () => {
    const events = [
      edit('t1', 5, 5),
      paste('t2'),
      edit('t3', 5, 5),
      edit('t4', 5, 5),
      checkpoint('t5'),
    ]
    const result = aggregateOldEditEvents(events)
    // Two separate edit runs: [t1] (len 1, untouched) and [t3,t4] (len 2, collapsed)
    expect(result.changed).toBe(true)
    const types = result.events.map((e) => e.type)
    expect(types).toEqual(['edit', 'paste', 'edit_summary', 'checkpoint'])
    expect(result.events[1]).toEqual(paste('t2')) // paste event completely unmodified
  })

  it('preserves multiple checkpoints, only summarizing before the LAST one', () => {
    const events = [
      edit('t1', 5, 5),
      edit('t2', 5, 5),
      checkpoint('t3'),
      edit('t4', 5, 5),
      edit('t5', 5, 5),
      checkpoint('t6'),
    ]
    const result = aggregateOldEditEvents(events)
    const types = result.events.map((e) => e.type)
    // Both runs are before the LAST checkpoint (t6), so both collapse.
    expect(types).toEqual(['edit_summary', 'checkpoint', 'edit_summary', 'checkpoint'])
  })
})
