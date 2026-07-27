/**
 * eu-ai-label.test.js — EU AI-disclosure icon classification
 * (src/lib/eu-ai-label.js)
 *
 * These thresholds decide which disclosure a user is shown, so the edges matter:
 * over-claiming ("fully AI generated" for a mostly-human doc) is a false
 * disclosure, and under-claiming defeats the purpose.
 */

import { describe, it, expect } from 'vitest'
import {
  EU_LABEL,
  classifyEuLabel,
  summariseSession,
  classifySessionEvents,
  euIconPath,
  euLabelText,
  FULLY_AI_THRESHOLD,
} from '../src/lib/eu-ai-label.js'

describe('classifyEuLabel', () => {
  it('returns NONE when no AI was used', () => {
    const r = classifyEuLabel({ humanChars: 1000, aiChars: 0 })
    expect(r.label).toBe(EU_LABEL.NONE)
    expect(r.aiShare).toBe(0)
  })

  it('returns NONE for an empty session', () => {
    expect(classifyEuLabel({}).label).toBe(EU_LABEL.NONE)
  })

  it('returns AI_GENERATED only when there is effectively no human authorship', () => {
    expect(classifyEuLabel({ humanChars: 0, aiChars: 500 }).label).toBe(EU_LABEL.AI_GENERATED)
  })

  it('does NOT claim fully-AI when a human wrote a real share (EU: "no human-created elements")', () => {
    // 5% human authorship — the EU mark requires no human-created elements,
    // so this must fall back to AI MODIFIED rather than over-claiming.
    expect(classifyEuLabel({ humanChars: 50, aiChars: 950 }).label).toBe(EU_LABEL.AI_MODIFIED)
    // 1% human is still real authorship, not measurement noise.
    expect(classifyEuLabel({ humanChars: 10, aiChars: 990 }).label).toBe(EU_LABEL.AI_MODIFIED)
  })

  it('absorbs sub-noise human counts into AI_GENERATED (documented tolerance)', () => {
    // 0.5% (a stray keystroke or counting drift) is within FULLY_AI_THRESHOLD's
    // deliberate tolerance — not treated as genuine human authorship.
    expect(classifyEuLabel({ humanChars: 5, aiChars: 995 }).label).toBe(EU_LABEL.AI_GENERATED)
  })

  it('returns AI_MODIFIED for a genuine human/AI mix', () => {
    expect(classifyEuLabel({ humanChars: 700, aiChars: 300 }).label).toBe(EU_LABEL.AI_MODIFIED)
    expect(classifyEuLabel({ humanChars: 500, aiChars: 500 }).label).toBe(EU_LABEL.AI_MODIFIED)
  })

  it('returns the basic AI mark when the AI contribution is minimal', () => {
    // 1% AI — real, but too small to claim the document was "AI modified"
    expect(classifyEuLabel({ humanChars: 9900, aiChars: 100 }).label).toBe(EU_LABEL.AI)
    // 0.1% — likewise just the neutral mark
    expect(classifyEuLabel({ humanChars: 99900, aiChars: 100 }).label).toBe(EU_LABEL.AI)
    // 5% clears MODIFIED_MIN_THRESHOLD, so it is a genuine AI-modified doc
    expect(classifyEuLabel({ humanChars: 950, aiChars: 50 }).label).toBe(EU_LABEL.AI_MODIFIED)
  })

  it('does not over-claim: a mostly-human doc is never AI_GENERATED', () => {
    const r = classifyEuLabel({ humanChars: 400, aiChars: 600 })
    expect(r.label).not.toBe(EU_LABEL.AI_GENERATED)
  })

  it('respects the FULLY_AI_THRESHOLD boundary', () => {
    const total = 1000
    const justUnder = classifyEuLabel({
      humanChars: total - Math.ceil(total * FULLY_AI_THRESHOLD) + 1,
      aiChars: Math.ceil(total * FULLY_AI_THRESHOLD) - 1,
    })
    expect(justUnder.label).toBe(EU_LABEL.AI_MODIFIED)
  })
})

describe('summariseSession', () => {
  it('ignores rejected AI suggestions entirely', () => {
    const events = [
      { type: 'edit', meta: { char_delta: 100, source: 'human' } },
      { type: 'ai_interaction', meta: { acceptance: 'rejected', ai_chars: 500 } },
    ]
    expect(summariseSession(events)).toEqual({ humanChars: 100, aiChars: 0 })
  })

  it('counts accepted AI characters', () => {
    const events = [
      { type: 'edit', meta: { char_delta: 100, source: 'human' } },
      { type: 'ai_interaction', meta: { acceptance: 'fully_accepted', ai_chars: 200 } },
    ]
    expect(summariseSession(events)).toEqual({ humanChars: 100, aiChars: 200 })
  })

  it('scales AI characters by similarity_score when the author reworded', () => {
    // AI produced 200 chars but only half its wording survived
    const events = [
      { type: 'ai_interaction', meta: { acceptance: 'modified', ai_chars: 200, similarity_score: 0.5 } },
    ]
    expect(summariseSession(events).aiChars).toBe(100)
  })

  it('does not count AI-sourced edits as human characters', () => {
    const events = [
      { type: 'edit', meta: { char_delta: 300, source: 'ai' } },
      { type: 'edit', meta: { char_delta: 100, source: 'human' } },
    ]
    expect(summariseSession(events).humanChars).toBe(100)
  })

  it('ignores deletions (negative deltas) rather than subtracting', () => {
    const events = [{ type: 'edit', meta: { char_delta: -50, source: 'human' } }]
    expect(summariseSession(events).humanChars).toBe(0)
  })

  it('handles an empty/undefined event list safely', () => {
    expect(summariseSession()).toEqual({ humanChars: 0, aiChars: 0 })
    expect(summariseSession([])).toEqual({ humanChars: 0, aiChars: 0 })
  })
})

describe('classifySessionEvents end-to-end', () => {
  it('labels a human doc with one accepted suggestion as AI_MODIFIED', () => {
    const events = [
      { type: 'edit', meta: { char_delta: 800, source: 'human' } },
      { type: 'ai_interaction', meta: { acceptance: 'fully_accepted', ai_chars: 200 } },
    ]
    expect(classifySessionEvents(events).label).toBe(EU_LABEL.AI_MODIFIED)
  })

  it('labels a doc with only rejected suggestions as NONE', () => {
    const events = [
      { type: 'edit', meta: { char_delta: 800, source: 'human' } },
      { type: 'ai_interaction', meta: { acceptance: 'rejected', ai_chars: 900 } },
    ]
    expect(classifySessionEvents(events).label).toBe(EU_LABEL.NONE)
  })
})

describe('euIconPath / euLabelText', () => {
  it('resolves packaged icon paths', () => {
    expect(euIconPath(EU_LABEL.AI)).toBe('assets/eu-icons/ai-black.svg')
    expect(euIconPath(EU_LABEL.AI_GENERATED, { colour: 'white' }))
      .toBe('assets/eu-icons/ai-generated-white.svg')
    expect(euIconPath(EU_LABEL.AI_MODIFIED, { colour: 'black', transparent: true }))
      .toBe('assets/eu-icons/ai-modified-black-transparent.svg')
  })

  it('returns null for NONE (nothing to display)', () => {
    expect(euIconPath(EU_LABEL.NONE)).toBeNull()
    expect(euIconPath(null)).toBeNull()
  })

  it('provides plain-language text for accessibility/alt text', () => {
    expect(euLabelText(EU_LABEL.AI_GENERATED)).toBe('AI generated')
    expect(euLabelText(EU_LABEL.AI_MODIFIED)).toBe('AI modified')
    expect(euLabelText(EU_LABEL.AI)).toBe('AI')
    expect(euLabelText(EU_LABEL.NONE)).toBe('')
  })
})
