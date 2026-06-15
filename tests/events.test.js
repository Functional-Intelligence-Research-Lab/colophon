/**
 * events.test.js — TWFF event constructors (src/lib/events.js)
 *
 * These constructors are shared infrastructure: their output is stored by the
 * service worker, rendered by the side panel, and hashed by the tamper-evident
 * chain. This locks in the two properties that matter most:
 *   1. every event is { type, timestamp, meta:{...} } (meta-wrapped) — the
 *      hash chain hashes event.meta, so a flat shape would break integrity.
 *   2. timestamp is a real ISO string (not the Date.toISOString *function*),
 *      and optional string fields don't crash on undefined.
 */

import { describe, it, expect } from 'vitest'
import {
  editEvent,
  pasteEvent,
  aiInteractionEvent,
  aiSuggestionEvent,
  sessionStartEvent,
  sessionEndEvent,
} from '../src/lib/events.js'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

describe('event constructors — common invariants', () => {
  const builders = {
    editEvent: () => editEvent({ content_before: '', content_after: '' }),
    pasteEvent: () => pasteEvent({ content_preview: '' }),
    aiInteractionEvent: () => aiInteractionEvent({}),
    aiSuggestionEvent: () => aiSuggestionEvent({}),
    sessionStartEvent: () => sessionStartEvent(),
    sessionEndEvent: () => sessionEndEvent(),
  }

  for (const [name, build] of Object.entries(builders)) {
    it(`${name} is meta-wrapped with an ISO timestamp`, () => {
      const e = build()
      expect(e).toHaveProperty('type')
      expect(e).toHaveProperty('meta')
      expect(typeof e.meta).toBe('object')
      expect(typeof e.timestamp).toBe('string')
      expect(e.timestamp).toMatch(ISO)
    })
  }
})

describe('event constructors — crash safety on undefined', () => {
  it('aiInteractionEvent does not throw when content fields are omitted', () => {
    expect(() => aiInteractionEvent({})).not.toThrow()
    const e = aiInteractionEvent({})
    expect(e.meta.content_before).toBe('')
    expect(e.meta.content_after).toBe('')
  })

  it('editEvent does not throw when content_before/after are omitted', () => {
    expect(() => editEvent({})).not.toThrow()
  })

  it('clips long content to schema limits', () => {
    const long = 'x'.repeat(900)
    const e = aiInteractionEvent({ content_after: long })
    expect(e.meta.content_after).toHaveLength(500)
  })
})

describe('aiSuggestionEvent / aiInteractionEvent fields', () => {
  it('carries model + acceptance into meta', () => {
    const e = aiSuggestionEvent({ model: 'google/gemini', acceptance: 'pending', text: 'hello' })
    expect(e.type).toBe('ai_suggestion')
    expect(e.meta.model).toBe('google/gemini')
    expect(e.meta.acceptance).toBe('pending')
    expect(e.meta.text).toBe('hello')
  })

  it('omits optional runtime extras when not provided', () => {
    const e = aiSuggestionEvent({ model: 'google/gemini' })
    expect(e.meta).not.toHaveProperty('text')
    expect(e.meta).not.toHaveProperty('source')
  })
})
