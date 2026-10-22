/**
 * annotate.test.js
 *
 * Regression coverage for the paste-annotation mislabeling bug: once pasted
 * text was deleted from the document, annotate.js's viewer kept marking the
 * text that replaced it as "pasted," because its match snapshot came from
 * the wrong field. Confirmed display-only (never reaches the exported CSV/
 * meta_json the research metrics read), but it's exactly what was reported
 * directly, so it's covered here.
 *
 * Only the pure, DOM-independent pieces of annotate.js (normalizeEvent,
 * selectSnapshot) are exercised — computeAnnotations() itself needs a real
 * DOMParser/TreeWalker this repo's Node test environment doesn't provide
 * (see tests/setup.js's deliberately minimal document stub), consistent
 * with how the rest of the suite avoids a jsdom/happy-dom dependency.
 */

import { describe, it, expect } from 'vitest'
import { normalizeEvent, selectSnapshot } from '../src/lib/annotate.js'

describe('selectSnapshot — paste vs. other event types', () => {
  it('prefers content_preview (the real pasted text) over content_after (surrounding context) for paste events', () => {
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'paste',
      meta: {
        content_preview: 'This is the text that was actually pasted.',
        // The 300 chars of document context *following* the paste — never
        // the pasted text itself (content.js's emitPaste()).
        content_after: 'Some unrelated sentence that happened to follow the paste in the document.',
      },
    }
    const e = normalizeEvent(raw, 0)
    expect(selectSnapshot(e)).toBe('This is the text that was actually pasted.')
  })

  it('falls back to content_after for a paste event with no content_preview', () => {
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'paste',
      meta: { content_after: 'only context available' },
    }
    const e = normalizeEvent(raw, 0)
    expect(selectSnapshot(e)).toBe('only context available')
  })

  it('still prefers content_after (the real kept text) for ai_interaction events', () => {
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'ai_interaction',
      meta: {
        acceptance: 'fully_accepted',
        content_after: 'The AI-generated text that was kept.',
        output_preview: 'The AI-generated text that was k...',
      },
    }
    const e = normalizeEvent(raw, 0)
    expect(selectSnapshot(e)).toBe('The AI-generated text that was kept.')
  })

  it('returns null when neither field has real content', () => {
    const raw = { timestamp: '2026-01-01T00:00:00.000Z', type: 'paste', meta: {} }
    const e = normalizeEvent(raw, 0)
    expect(selectSnapshot(e)).toBeNull()
  })
})

describe('normalizeEvent', () => {
  it('treats the sentinel "[snapshot unavailable]" string as absent, not real content', () => {
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'ai_interaction',
      meta: { content_before: '[snapshot unavailable]', content_after: 'kept text' },
    }
    const e = normalizeEvent(raw, 0)
    expect(e.contentBefore).toBeNull()
    expect(e.contentAfter).toBe('kept text')
  })
})
