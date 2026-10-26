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
import {
  normalizeEvent, selectSnapshot, classifyReliability, classifyLayer, fuzzyLocate,
} from '../src/lib/annotate.js'

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

describe('classifyReliability — paste vs. other event types', () => {
  it('trusts a paste\'s own posStart/posEnd even when they differ wildly from content_after\'s length', () => {
    // A real 500-char paste: content_after is ~300 chars of trailing
    // document context, not the pasted text, so comparing their lengths is
    // meaningless for a paste — it used to wrongly downgrade this to
    // 'length-only', routing every real paste through the weaker
    // fuzzy-search-only path instead of trusting its own accurate offset.
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'paste',
      meta: { position_start: 100, position_end: 600, content_after: 'x'.repeat(300) },
    }
    const e = normalizeEvent(raw, 0)
    expect(classifyReliability(e, 1000)).toBe('position')
  })

  it('still downgrades a non-paste event when its length disagrees with content_after', () => {
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'edit_block',
      meta: { source: 'human', position_start: 100, position_end: 600, content_after: 'x'.repeat(300) },
    }
    const e = normalizeEvent(raw, 0)
    expect(classifyReliability(e, 1000)).toBe('length-only')
  })

  it('trusts a real human edit_block at document position 0 when content_after confirms the length', () => {
    // A real edit at the very start of a document (now that flushEdit()
    // populates content_after instead of leaving it absent) must be trusted
    // the same way a position-0 paste already is, not downgraded just
    // because it isn't type 'paste'.
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'edit_block',
      meta: { source: 'human', position_start: 0, position_end: 6, content_after: 'brown ' },
    }
    const e = normalizeEvent(raw, 0)
    expect(classifyReliability(e, 0)).toBe('position')
  })

  it('still downgrades a position-0 edit_block whose length does not match content_after', () => {
    // The pre-fix producer bug shape: position_end is really a keystroke
    // delta, not a real offset, so it won't agree with content_after's
    // actual length when content_after happens to be absent/wrong.
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'edit_block',
      meta: { source: 'human', position_start: 0, position_end: 4 },
    }
    const e = normalizeEvent(raw, 0)
    expect(classifyReliability(e, 0)).toBe('length-only')
  })
})

describe('fuzzyLocate — short needles', () => {
  it('matches a needle under 10 characters on the first (full-length) attempt', () => {
    // The loop used to `break` on its very first iteration whenever the
    // needle itself was under 10 characters, so short pastes were never
    // even attempted via fuzzy search at all.
    const finalText = 'Some document text with a short snippet in the middle of it.'
    const found = fuzzyLocate(finalText, 'snippet', 7, 0, [])
    expect(found).not.toBeNull()
    expect(finalText.slice(found.start, found.end)).toBe('snippet')
  })
})

describe('classifyLayer — self-reported AI pastes', () => {
  it('classifies a paste with source_tool as paste-ai-disclosed, not plain paste', () => {
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'paste',
      meta: { source: 'external', source_tool: 'ChatGPT' },
    }
    const e = normalizeEvent(raw, 0)
    expect(classifyLayer(e)).toBe('paste-ai-disclosed')
  })

  it('classifies an ordinary paste with no source_tool as plain paste', () => {
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'paste',
      meta: { source: 'external' },
    }
    const e = normalizeEvent(raw, 0)
    expect(classifyLayer(e)).toBe('paste')
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
