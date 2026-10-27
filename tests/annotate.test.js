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
  buildOplog, mapForward, compositeKey, cssClassFor, computeStats,
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

describe('buildOplog/mapForward — position drift correction', () => {
  // flushEdit() (content.js) defines position_end as prefixLen +
  // addedRaw.length -- i.e. posEnd-posStart is always the INSERTED length,
  // never the deleted one. buildOplog() used to read `deleted` straight off
  // that difference, which collapsed every edit's net shift
  // (inserted-deleted) to zero regardless of whether it was a pure
  // insertion, a pure deletion, or a different-length replacement -- only a
  // same-length replacement was ever correct, by coincidence. These tests
  // build real normalized events and run them through the real
  // buildOplog()/mapForward() pipeline (not a hand-built oplog), so they
  // fail against the pre-fix formula and pass against the fix.

  // None of this suite's events hit classifyReliability()'s docLenEstimate-
  // dependent (posStart===0 && posEnd===0) branch (every test event has a
  // nonzero posStart or posEnd), so a fixed nonzero estimate is sufficient
  // here rather than replicating computeAnnotations()'s own running tally.
  function reliabilityMapFor(events) {
    const reliability = new Map()
    for (const e of events) reliability.set(e.id, classifyReliability(e, 9999))
    return reliability
  }

  it('shifts a later position FORWARD after a pure insertion (not zero, not the wrong "collapsed" branch)', () => {
    // "ABCDEFGHIJ" -> insert "XYZ" at position 3 -> "ABCXYZDEFGHIJ".
    // Tracking position 5 (originally 'E', right after the insertion point)
    // must land at 8 in the final text. The pre-fix formula computed
    // deleted=posEnd-posStart=3 (equal to inserted, wrongly implying a
    // same-length replacement), producing a "collapsed" result of 6 instead.
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'edit_block',
      meta: {
        source: 'human', position_start: 3, position_end: 6,
        content_before: '', content_after: 'XYZ',
        content_before_length: 0, content_after_length: 3,
      },
    }
    const e = normalizeEvent(raw, 0)
    const oplog = buildOplog([e], reliabilityMapFor([e]))
    const result = mapForward(5, -1, oplog)
    expect(result.pos).toBe(8)
    expect(result.collapsed).toBe(false)
  })

  it('shifts a later position BACKWARD after a pure deletion (not left unchanged)', () => {
    // "ABCXYZGHIJ" -> delete "GH" (2 chars) at position 6 -> "ABCXYZIJ".
    // Tracking position 10 (well after the deletion) must land at 8. The
    // pre-fix formula computed deleted=posEnd-posStart=0 for a pure
    // deletion (content_after is '', so posEnd===posStart===6), wrongly
    // implying nothing was removed, and left the tracked position
    // unchanged at 10 instead of shifting it back by 2.
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'edit_block',
      meta: {
        source: 'human', position_start: 6, position_end: 6,
        content_before: 'GH', content_after: '',
        content_before_length: 2, content_after_length: 0,
      },
    }
    const e = normalizeEvent(raw, 0)
    const oplog = buildOplog([e], reliabilityMapFor([e]))
    const result = mapForward(10, -1, oplog)
    expect(result.pos).toBe(8)
  })

  it('correctly composes three sequential edits (insertion, deletion, different-length replacement)', () => {
    // "ABCDEFGHIJ"
    //   -> insert "XYZ" @3            -> "ABCXYZDEFGHIJ" (len 13)
    //   -> delete "DEF" @6            -> "ABCXYZGHIJ"    (len 10)
    //   -> replace "GH"->"123456" @6  -> "ABCXYZ123456IJ" (len 14)
    // 'I', originally at position 8 in the untouched document, must land at
    // position 12 in the final text.
    const rawEvents = [
      {
        timestamp: '2026-01-01T00:00:01.000Z', type: 'edit_block',
        meta: {
          source: 'human', position_start: 3, position_end: 6,
          content_before: '', content_after: 'XYZ',
          content_before_length: 0, content_after_length: 3,
        },
      },
      {
        timestamp: '2026-01-01T00:00:02.000Z', type: 'edit_block',
        meta: {
          source: 'human', position_start: 6, position_end: 6,
          content_before: 'DEF', content_after: '',
          content_before_length: 3, content_after_length: 0,
        },
      },
      {
        timestamp: '2026-01-01T00:00:03.000Z', type: 'edit_block',
        meta: {
          source: 'human', position_start: 6, position_end: 12,
          content_before: 'GH', content_after: '123456',
          content_before_length: 2, content_after_length: 6,
        },
      },
    ]
    const events = rawEvents.map((raw, i) => normalizeEvent(raw, i))
    const oplog = buildOplog(events, reliabilityMapFor(events))
    const result = mapForward(8, 0, oplog)
    expect(result.pos).toBe(12)
  })

  it('a bare paste with no paired edit_block(external) is treated as a pure insertion (deleted=0), not posEnd-posStart', () => {
    // A plain paste's own position_start/position_end describe where the
    // pasted text now sits, never anything it replaced (paste has no
    // content_before concept at all) -- deletedLength() must return 0 for
    // it rather than reusing posEnd-posStart (which equals charCount here,
    // wrongly implying the paste replaced charCount characters).
    const raw = {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'paste',
      meta: { source: 'external', position_start: 3, position_end: 8, char_count: 5 },
    }
    const e = normalizeEvent(raw, 0)
    const oplog = buildOplog([e], reliabilityMapFor([e]))
    const result = mapForward(3, -1, oplog)
    // A pure 5-char insertion at position 3 shifts a tracked position
    // already at 3 forward to 8 (atPosition+inserted), never backward.
    expect(result.pos).toBe(8)
  })

  it('a paste paired with a same-timestamp edit_block(source:external) contributes only one drift op, not double', () => {
    // Once the producer emits the spec-mandated pairing (a paste always
    // paired with an edit_block(source:'external') at the identical
    // timestamp), buildOplog() must use only the edit_block's richer,
    // verified lengths -- counting both would shift later positions by
    // roughly double the real insertion.
    const ts = '2026-01-01T00:00:00.000Z'
    const rawPaste = {
      timestamp: ts, type: 'paste',
      meta: { source: 'external', position_start: 3, position_end: 8, char_count: 5 },
    }
    const rawEditBlock = {
      timestamp: ts, type: 'edit_block',
      meta: {
        source: 'external', position_start: 3, position_end: 8,
        content_before: '', content_after: 'XYZXY',
        content_before_length: 0, content_after_length: 5,
      },
    }
    const events = [rawPaste, rawEditBlock].map((raw, i) => normalizeEvent(raw, i))
    const oplog = buildOplog(events, reliabilityMapFor(events))
    expect(oplog.length).toBe(1)
    expect(oplog[0].inserted).toBe(5)
    const result = mapForward(3, -1, oplog)
    expect(result.pos).toBe(8) // not 13, which double-counting would produce
  })
})

describe('compositeKey/cssClassFor — composite labels must match what compositeKey can actually produce', () => {
  const aiLayer = { type: 'ai_interaction', acceptance: 'fully_accepted', model: 'anthropic/claude' }
  const humanLayer = { type: 'edit_block', source: 'human' }
  const pasteLayer = { type: 'paste', source: 'external' }

  it('AI content later edited by hand composites to "ai-then-human", not an unreachable "ai-then-edited"', () => {
    const key = compositeKey([aiLayer, humanLayer])
    expect(key).toBe('ai-then-human')
    // The actual regression: this key used to have no matching LEGEND/known
    // entry at all (only the never-producible 'ai-then-edited' existed),
    // silently falling through to the generic composite class.
    expect(cssClassFor(key)).toBe('ann-ai-then-human')
    expect(cssClassFor(key)).not.toBe('ann-composite')
  })

  it('pasted content later typed over by the author gets its own label, not the generic composite fallback', () => {
    const key = compositeKey([pasteLayer, humanLayer])
    expect(key).toBe('paste-then-human')
    expect(cssClassFor(key)).toBe('ann-paste-then-human')
    expect(cssClassFor(key)).not.toBe('ann-composite')
  })
})

describe('computeStats — bounded coverage range for unlocated activity', () => {
  // The exact real-world bug: a paste spans the whole 100-char document,
  // then 20 characters of human editing happen that the engine couldn't
  // locate (no content snapshot). Without this fix, pasteCoveragePct stays
  // a flat 100% forever, regardless of how much real editing happened.
  const wholeDocPasteRange = (docLength) => [{ start: 0, end: docLength, history: [{ type: 'paste', source: 'external' }] }]

  it('min === max (today\'s single-number behavior) when nothing is unlocated', () => {
    const stats = computeStats([], wholeDocPasteRange(100), 100, [])
    expect(stats.pasteCoveragePct).toBe(100)
    expect(stats.pasteCoverageMin).toBe(100)
    expect(stats.pasteCoverageMax).toBe(100)
    expect(stats.untrackedChars).toBe(0)
    expect(stats.untrackedCount).toBe(0)
  })

  it('an unlocated human edit narrows pasteCoverage downward only, never upward', () => {
    const unlocatedList = [{ event: { type: 'edit_block', source: 'human', charCount: 20 }, reason: 'unlocated-no-snapshot' }]
    const stats = computeStats([], wholeDocPasteRange(100), 100, unlocatedList)
    expect(stats.pasteCoveragePct).toBe(100) // unchanged point estimate
    expect(stats.pasteCoverageMin).toBe(80)  // 100 - 20
    expect(stats.pasteCoverageMax).toBe(100) // a human edit can't increase paste coverage
    expect(stats.aiCoverageMin).toBe(0)      // clamped, can't go below 0
    expect(stats.aiCoverageMax).toBe(0)      // no unlocated AI activity
    expect(stats.untrackedChars).toBe(20)
    expect(stats.untrackedCount).toBe(1)
  })

  it('an unlocated accepted AI interaction widens aiCoverage upward only, never downward', () => {
    const unlocatedList = [{
      event: { type: 'ai_interaction', acceptance: 'fully_accepted', charCount: 15 },
      reason: 'unlocated-no-match',
    }]
    const stats = computeStats([], [{ start: 0, end: 100, history: [] }], 100, unlocatedList)
    expect(stats.aiCoveragePct).toBe(0)
    expect(stats.aiCoverageMin).toBe(0)
    expect(stats.aiCoverageMax).toBe(15)
    expect(stats.pasteCoverageMin).toBe(0)
    expect(stats.pasteCoverageMax).toBe(0) // AI activity never widens paste coverage
  })

  it('an unlocated self-reported-AI paste widens BOTH ai and paste coverage upward', () => {
    const unlocatedList = [{
      event: { type: 'paste', source_tool: 'chatgpt', charCount: 10 },
      reason: 'unlocated-no-snapshot',
    }]
    const stats = computeStats([], [{ start: 0, end: 100, history: [] }], 100, unlocatedList)
    expect(stats.aiCoverageMax).toBe(10)
    expect(stats.pasteCoverageMax).toBe(10)
  })

  it('a self-reported "not_ai" paste counts toward paste only, not ai — matching classifyLayer\'s own not_ai exclusion', () => {
    const unlocatedList = [{
      event: { type: 'paste', source_tool: 'not_ai', charCount: 10 },
      reason: 'unlocated-no-snapshot',
    }]
    const stats = computeStats([], [{ start: 0, end: 100, history: [] }], 100, unlocatedList)
    expect(stats.pasteCoverageMax).toBe(10)
    expect(stats.aiCoverageMax).toBe(0)
  })

  it('clamps at 0 and 100 rather than producing an invalid range', () => {
    const unlocatedList = [{ event: { type: 'edit_block', source: 'human', charCount: 500 }, reason: 'unlocated-no-snapshot' }]
    const stats = computeStats([], wholeDocPasteRange(100), 100, unlocatedList)
    expect(stats.pasteCoverageMin).toBe(0) // not -400
  })
})
