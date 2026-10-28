/**
 * annotate-confidence-ambiguity.test.js
 *
 * Confidence/locatedVia used to be computed by verify()/fuzzyLocate() and
 * then silently dropped before reaching applyProvenance() or any stat --
 * an offset-verified exact match and a loosely fuzzy-matched range
 * rendered identically, and coverage percentages lumped high- and
 * low-confidence matches together with no distinction. Covers the fix: a
 * frozen, deterministic four-tier policy (high / medium / ambiguous /
 * unlocated), confidence that changes what counts toward the exact
 * coverage point estimate (not just how a range is drawn), and genuine
 * ambiguity (two near-identical repeated passages) that's never silently
 * resolved to one candidate.
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

let computeAnnotations, fuzzyLocate, AMBIGUITY_MARGIN_FRACTION

beforeAll(async () => {
  ({ computeAnnotations, fuzzyLocate, AMBIGUITY_MARGIN_FRACTION } = await import('../src/lib/annotate.js'))
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

describe('fuzzyLocate — confidence tiers and frozen ambiguity margin (unit level)', () => {
  it('a single full-needle match (tier 0) is high confidence', () => {
    const text = 'Some prefix text. The quick brown fox jumps over the lazy dog. Trailing text.'
    const found = fuzzyLocate(text, 'The quick brown fox jumps over the lazy dog.', 44, 0, [])
    expect(found.ambiguous).toBe(false)
    expect(found.confidence).toBe('high')
  })

  it('a match only found via a shorter fallback prefix is medium confidence, not high', () => {
    // The needle's full text does NOT appear verbatim (changed ending), so
    // only a shorter prefix tier finds anything.
    const text = 'Some prefix text. The quick brown fox jumps over something totally different now.'
    const needle = 'The quick brown fox jumps over the lazy dog, repeatedly and with great enthusiasm.'
    const found = fuzzyLocate(text, needle, needle.length, 0, [])
    expect(found.ambiguous).toBe(false)
    expect(found.confidence).toBe('medium')
  })

  it('two near-identical repeated passages are reported ambiguous, never silently resolved to one', () => {
    const repeated = 'The committee reviewed the proposal carefully before deciding.'
    const middle = ' Some middle text here. '
    const text = `${repeated}${middle}${repeated}`
    const secondStart = repeated.length + middle.length
    // Origin placed at the midpoint between the two occurrences -- each is
    // equally plausible (gap between their distances-to-origin is ~0,
    // well under the margin), which is exactly the case the margin rule
    // exists to catch. (An origin hint far from both, e.g. 0, trivially
    // favors whichever occurrence is closer to the start -- that's NOT
    // what "ambiguous" means here; it means two candidates are too close
    // to EACH OTHER to call, given where the search was actually expecting
    // to find this text.)
    const origin = Math.round(secondStart / 2)
    const found = fuzzyLocate(text, repeated, repeated.length, origin, [])
    expect(found.ambiguous).toBe(true)
    expect(found.candidates.length).toBeGreaterThanOrEqual(2)
  })

  it('a clear origin hint resolves a repeated phrase unambiguously when the gap exceeds the margin', () => {
    const repeated = 'short phrase here'
    // Pad enough that one occurrence is unambiguously closer to the origin
    // hint than the margin (20% of the needle length) allows for doubt.
    const padding = 'x'.repeat(500)
    const text = `${repeated}${padding}${repeated}`
    const found = fuzzyLocate(text, repeated, repeated.length, 0, [])
    expect(found.ambiguous).toBe(false)
  })

  it('returns null (unlocated), not a false positive, when nothing matches at all', () => {
    const found = fuzzyLocate('Completely unrelated document text here.', 'Nothing like this exists anywhere', 30, 0, [])
    expect(found).toBeNull()
  })

  it('AMBIGUITY_MARGIN_FRACTION is a frozen, exported constant, not an inline magic number', () => {
    expect(AMBIGUITY_MARGIN_FRACTION).toBe(0.20)
  })
})

describe('computeAnnotations — confidence end to end with a real DOM', () => {
  it('an exact offset+snapshot match gets high confidence and no certainty CSS modifier', () => {
    const xhtml = '<html><body><p>The quick brown fox jumps over the lazy dog.</p></body></html>'
    const log = buildLog([
      { type: 'session_start', timestamp: '2026-01-01T10:00:00.000Z', meta: {} },
      {
        type: 'ai_interaction', timestamp: '2026-01-01T10:01:00.000Z',
        meta: {
          model: 'test-model', output_preview: 'The quick', acceptance: 'fully_accepted',
          position_start: 0, position_end: 44,
          content_after: 'The quick brown fox jumps over the lazy dog.',
          content_after_length: 44,
        },
      },
      { type: 'session_end', timestamp: '2026-01-01T10:20:00.000Z', meta: {} },
    ])
    const computed = computeAnnotations(xhtml, log)
    expect(computed.unlocatedList).toHaveLength(0)
    expect(computed.ambiguousList).toHaveLength(0)
    const range = computed.provenanceRanges.find((r) => r.history.length > 0)
    expect(range.history[0].confidence).toBe('high')
    expect(computed.stats.evidenceSummary.placedExact).toBe(1)
    expect(computed.stats.evidenceSummary.placedInferred).toBe(0)
    // High confidence -> counts toward the exact point estimate directly.
    expect(computed.stats.aiCoveragePct).toBeGreaterThan(0)
    expect(computed.stats.aiCoverageMin).toBe(computed.stats.aiCoveragePct)
    expect(computed.stats.aiCoverageMax).toBe(computed.stats.aiCoveragePct)
  })

  it('a genuinely ambiguous match never becomes a provenance range, and widens the uncertainty band instead of the point estimate', () => {
    const repeated = 'The committee reviewed the proposal carefully before deciding on the matter.'
    const middle = ' Unrelated middle sentence here. '
    const xhtml = `<html><body><p>${repeated}${middle}${repeated}</p></body></html>`
    const secondStart = repeated.length + middle.length
    const origin = Math.round(secondStart / 2)
    const log = buildLog([
      { type: 'session_start', timestamp: '2026-01-01T10:00:00.000Z', meta: {} },
      {
        type: 'ai_interaction', timestamp: '2026-01-01T10:01:00.000Z',
        meta: {
          model: 'test-model', output_preview: 'The committee', acceptance: 'fully_accepted',
          // A position deliberately NOT matching either real occurrence's
          // content (verify() will reject it, forcing the fuzzy fallback)
          // but placed at the midpoint between the two real occurrences,
          // so the fallback's own origin hint lands exactly where
          // ambiguity should be detected.
          position_start: origin, position_end: origin + repeated.length,
          content_after: repeated,
          content_after_length: repeated.length,
          ai_chars: repeated.length,
        },
      },
      { type: 'session_end', timestamp: '2026-01-01T10:20:00.000Z', meta: {} },
    ])
    const computed = computeAnnotations(xhtml, log)
    expect(computed.ambiguousList).toHaveLength(1)
    expect(computed.unlocatedList).toHaveLength(0)
    // Never applied as a confirmed range -- both occurrences stay plain
    // 'human' (untouched), not drawn as if one were confirmed AI content.
    const taggedRanges = computed.provenanceRanges.filter((r) => r.history.length > 0)
    expect(taggedRanges).toHaveLength(0)
    // The ambiguous event still widens the AI-coverage uncertainty band
    // (its true effect is unknown, same direction as "unlocated"), but
    // contributes nothing to the exact point estimate.
    expect(computed.stats.aiCoveragePct).toBe(0)
    expect(computed.stats.aiCoverageMax).toBeGreaterThan(computed.stats.aiCoveragePct)
    expect(computed.stats.evidenceSummary.ambiguous).toBe(1)
  })
})
