/**
 * similarity.test.js — src/lib/similarity.js
 *
 * Shared by sidepanel.js (side-panel-originated suggestions) and content.js/
 * gemini-detector.js (native Gemini suggestions) to compute TWFF's
 * similarity_score field (spec v0.2 §4.4).
 */

import { describe, it, expect } from 'vitest'
import { jaccardSimilarity, acceptanceFromSimilarity } from '../src/lib/similarity.js'

describe('jaccardSimilarity', () => {
  it('returns 1 for identical text', () => {
    expect(jaccardSimilarity('the quick brown fox', 'the quick brown fox')).toBe(1)
  })

  it('returns 0 for completely disjoint text', () => {
    expect(jaccardSimilarity('apples oranges', 'zebras xylophones')).toBe(0)
  })

  it('returns 0 when both strings are empty', () => {
    expect(jaccardSimilarity('', '')).toBe(0)
  })

  it('is order- and duplicate-insensitive (word-set overlap, not sequence match)', () => {
    // A reordered paraphrase of the same words should still score as fully similar.
    expect(jaccardSimilarity('fox brown quick the', 'the quick brown fox')).toBe(1)
  })

  it('scores partial overlap between 0 and 1', () => {
    const score = jaccardSimilarity('the quick brown fox', 'the quick red fox')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })

  it('does not throw on null/undefined input', () => {
    expect(() => jaccardSimilarity(null, undefined)).not.toThrow()
    expect(jaccardSimilarity(null, undefined)).toBe(0)
  })
})

describe('acceptanceFromSimilarity', () => {
  it('maps high similarity to fully_accepted', () => {
    expect(acceptanceFromSimilarity(0.95)).toBe('fully_accepted')
    expect(acceptanceFromSimilarity(0.9)).toBe('fully_accepted')
  })

  it('maps mid-high similarity to partially_accepted', () => {
    expect(acceptanceFromSimilarity(0.7)).toBe('partially_accepted')
    expect(acceptanceFromSimilarity(0.5)).toBe('partially_accepted')
  })

  it('maps low-mid similarity to modified', () => {
    expect(acceptanceFromSimilarity(0.3)).toBe('modified')
    expect(acceptanceFromSimilarity(0.1)).toBe('modified')
  })

  it('maps near-zero similarity to rejected', () => {
    expect(acceptanceFromSimilarity(0.05)).toBe('rejected')
    expect(acceptanceFromSimilarity(0)).toBe('rejected')
  })
})
