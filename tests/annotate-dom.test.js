/**
 * annotate-dom.test.js
 *
 * computeAnnotations() (the full pipeline: classifyReliability -> buildOplog
 * -> verify/fuzzyLocate -> applyProvenance -> computeStats) had ZERO test
 * coverage in this repo — the rest of the suite deliberately runs under
 * `environment: 'node'` (tests/setup.js's own minimal document stub), since
 * this file needs a real DOMParser/TreeWalker/NodeFilter computeAnnotations()
 * depends on.
 *
 * Rather than switching to vitest's built-in `@vitest-environment jsdom`
 * (its ambient `window` turned out to trip up dompurify's own browser-vs-
 * Node build detection — `createDOMPurify(window)` returned something with
 * no `.sanitize`, confirmed by direct inspection, not assumed), this builds
 * its own `jsdom` instance explicitly and mocks the `dompurify` import
 * annotate.js makes, so annotate.js's unmodified `import DOMPurify from
 * 'dompurify'; DOMPurify.sanitize(...)` resolves to a real, working
 * sanitizer bound to that instance's `window` — the same construction this
 * round's scratchpad verification harness already proved works.
 *
 * This is exactly the missing bridge: a no-snapshot edit_block (the shape
 * flushEdit()'s fallback actually produces — see
 * content-edit-position.test.js) run through the REAL end-to-end pipeline,
 * confirming it lands in unlocatedList and correctly narrows the bounded
 * coverage range (computeStats' pasteCoverageMin/Max) rather than silently
 * vanishing with no numeric trace — the precise mechanism behind the real-
 * world "5 edits, still 99% pasted" bug this round's work fixed.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/' })
global.document = dom.window.document
global.DOMParser = dom.window.DOMParser
global.NodeFilter = dom.window.NodeFilter

vi.mock('dompurify', async () => {
  const actual = await vi.importActual('dompurify')
  const createDOMPurify = actual.default
  return { default: createDOMPurify(dom.window) }
})

let computeAnnotations

beforeAll(async () => {
  ({ computeAnnotations } = await import('../src/lib/annotate.js'))
})

function buildLog(events) {
  return {
    version: '0.2.0',
    session_id: 'test-session',
    start_time: '2026-01-01T10:00:00.000Z',
    end_time: '2026-01-01T10:20:00.000Z',
    content_source: 'content/document.xhtml',
    events,
  }
}

describe('computeAnnotations — end to end with a real DOM', () => {
  it('locates a correctly-paired paste + edit_block(external) and splits around a later human edit', () => {
    // "The quick brown fox jumps over the lazy dog." (44 chars) pasted as
    // one block at [0, 44); one untracked space at position 44 (just
    // ambient document text, no event -- same as any character no event
    // ever touched); then "Really." (7 chars) typed by the author at
    // [45, 52). The gap at 44 deliberately keeps the human edit's start
    // strictly greater than the paste's own end: mapForward()'s boundary
    // convention (an op whose atPosition exactly equals an earlier range's
    // end drifts that end forward to include the insertion, by design --
    // see buildOplog/mapForward's own tests) would otherwise pull the
    // paste's own snapshot check into the edit's inserted text too, which
    // is a separate, pre-existing fuzzy-matching edge case this test isn't
    // about. The xhtml here is the FINAL document state (what
    // computeAnnotations always receives), so it already reflects the edit.
    const xhtml = '<html><body><p>The quick brown fox jumps over the lazy dog. Really.</p></body></html>'
    const log = buildLog([
      { type: 'session_start', timestamp: '2026-01-01T10:00:00.000Z', meta: {} },
      {
        type: 'paste', timestamp: '2026-01-01T10:01:00.000Z',
        meta: {
          source: 'external', position_start: 0, position_end: 44, char_count: 44,
          content_preview: 'The quick brown fox jumps over the lazy dog.',
        },
      },
      {
        type: 'edit_block', timestamp: '2026-01-01T10:01:00.000Z', // paired, same timestamp
        meta: {
          source: 'external', position_start: 0, position_end: 44,
          content_before: '', content_after: 'The quick brown fox jumps over the lazy dog.',
          content_before_length: 0, content_after_length: 44,
        },
      },
      {
        type: 'edit_block', timestamp: '2026-01-01T10:05:00.000Z',
        meta: {
          source: 'human', position_start: 45, position_end: 52,
          content_before: '', content_after: 'Really.',
          content_before_length: 0, content_after_length: 7,
        },
      },
      { type: 'session_end', timestamp: '2026-01-01T10:20:00.000Z', meta: {} },
    ])

    const computed = computeAnnotations(xhtml, log)
    expect(computed.unlocatedList).toHaveLength(0)
    expect(computed.stats.editCount).toBe(1) // the paired external edit_block is excluded
    expect(computed.stats.pasteCoverageMin).toBe(computed.stats.pasteCoverageMax) // nothing unlocated -> no range
    expect(computed.stats.pasteCoveragePct).toBeLessThan(100) // the human edit genuinely carved out a human span
  })

  it('a no-snapshot human edit_block (flushEdit()\'s real fallback shape) lands in unlocatedList and narrows the coverage range instead of silently vanishing', () => {
    const xhtml = '<html><body><p>The quick brown fox jumps over the lazy dog.</p></body></html>'
    const log = buildLog([
      { type: 'session_start', timestamp: '2026-01-01T10:00:00.000Z', meta: {} },
      {
        type: 'paste', timestamp: '2026-01-01T10:01:00.000Z',
        meta: {
          source: 'external', position_start: 0, position_end: 44, char_count: 44,
          content_preview: 'The quick brown fox jumps over the lazy dog.',
        },
      },
      {
        type: 'edit_block', timestamp: '2026-01-01T10:01:00.000Z',
        meta: {
          source: 'external', position_start: 0, position_end: 44,
          content_before: '', content_after: 'The quick brown fox jumps over the lazy dog.',
          content_before_length: 0, content_after_length: 44,
        },
      },
      // The real degraded shape (see content-edit-position.test.js's "falls
      // back to..." tests, and P2's fix to omit rather than default to 0):
      // no position_start/position_end at all, just a char-count delta.
      {
        type: 'edit_block', timestamp: '2026-01-01T10:05:00.000Z',
        meta: { source: 'human', char_delta: 6, char_count: 6 },
      },
      { type: 'session_end', timestamp: '2026-01-01T10:20:00.000Z', meta: {} },
    ])

    const computed = computeAnnotations(xhtml, log)
    expect(computed.unlocatedList).toHaveLength(1)
    expect(computed.unlocatedList[0].event.type).toBe('edit_block')
    // Still counted as a real edit even though it couldn't be located.
    expect(computed.stats.editCount).toBe(1)
    // The point estimate alone would still (wrongly, on its own) imply 100%
    // confidence -- the range is what must reflect the real uncertainty.
    expect(computed.stats.pasteCoveragePct).toBe(100)
    expect(computed.stats.pasteCoverageMin).toBeLessThan(100)
    expect(computed.stats.untrackedCount).toBe(1)
    expect(computed.stats.untrackedChars).toBe(6)
  })
})
