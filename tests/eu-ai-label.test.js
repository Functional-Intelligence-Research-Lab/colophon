/**
 * eu-ai-label.test.js — EU AI-disclosure icon classification
 * (src/lib/eu-ai-label.js)
 *
 * These thresholds decide which disclosure a user is shown, so the edges matter:
 * over-claiming ("fully AI generated" for a mostly-human doc) is a false
 * disclosure, and under-claiming defeats the purpose.
 *
 * `observedAiChars` below is system-observed evidence (an ai_interaction/
 * ai_suggestion Colophon directly watched) — the normal case these tests
 * exercise. `selfReportedAiChars` (a paste's own source_tool disclosure,
 * never directly observed) is a separate axis, covered in its own section:
 * it used to not exist at all, so a session that was entirely one
 * disclosed-AI paste silently returned NONE ("no AI contribution") — the
 * opposite of overclaiming, but still wrong. Fixed, and kept honestly
 * hedged rather than swinging to overclaiming instead.
 */

import { describe, it, expect } from 'vitest'
import {
  EU_LABEL,
  EVIDENCE_BASIS,
  SELF_REPORTED_ONLY_REASON,
  classifyEuLabel,
  summariseSession,
  classifySessionEvents,
  euIconPath,
  euLabelText,
  FULLY_AI_THRESHOLD,
} from '../src/lib/eu-ai-label.js'

describe('classifyEuLabel — system-observed evidence', () => {
  it('returns NONE when no AI was used', () => {
    const r = classifyEuLabel({ humanChars: 1000, observedAiChars: 0 })
    expect(r.label).toBe(EU_LABEL.NONE)
    expect(r.aiShare).toBe(0)
    expect(r.evidenceBasis).toBe(EVIDENCE_BASIS.NONE)
  })

  it('returns NONE for an empty session', () => {
    expect(classifyEuLabel({}).label).toBe(EU_LABEL.NONE)
  })

  it('returns AI_GENERATED only when there is effectively no human authorship', () => {
    const r = classifyEuLabel({ humanChars: 0, observedAiChars: 500 })
    expect(r.label).toBe(EU_LABEL.AI_GENERATED)
    expect(r.evidenceBasis).toBe(EVIDENCE_BASIS.SYSTEM_OBSERVED)
  })

  it('does NOT claim fully-AI when a human wrote a real share (EU: "no human-created elements")', () => {
    // 5% human authorship — the EU mark requires no human-created elements,
    // so this must fall back to AI MODIFIED rather than over-claiming.
    expect(classifyEuLabel({ humanChars: 50, observedAiChars: 950 }).label).toBe(EU_LABEL.AI_MODIFIED)
    // 1% human is still real authorship, not measurement noise.
    expect(classifyEuLabel({ humanChars: 10, observedAiChars: 990 }).label).toBe(EU_LABEL.AI_MODIFIED)
  })

  it('absorbs sub-noise human counts into AI_GENERATED (documented tolerance)', () => {
    // 0.5% (a stray keystroke or counting drift) is within FULLY_AI_THRESHOLD's
    // deliberate tolerance — not treated as genuine human authorship.
    expect(classifyEuLabel({ humanChars: 5, observedAiChars: 995 }).label).toBe(EU_LABEL.AI_GENERATED)
  })

  it('returns AI_MODIFIED for a genuine human/AI mix', () => {
    expect(classifyEuLabel({ humanChars: 700, observedAiChars: 300 }).label).toBe(EU_LABEL.AI_MODIFIED)
    expect(classifyEuLabel({ humanChars: 500, observedAiChars: 500 }).label).toBe(EU_LABEL.AI_MODIFIED)
  })

  it('returns the basic AI mark when the AI contribution is minimal', () => {
    // 1% AI — real, but too small to claim the document was "AI modified"
    expect(classifyEuLabel({ humanChars: 9900, observedAiChars: 100 }).label).toBe(EU_LABEL.AI)
    // 0.1% — likewise just the neutral mark
    expect(classifyEuLabel({ humanChars: 99900, observedAiChars: 100 }).label).toBe(EU_LABEL.AI)
    // 5% clears MODIFIED_MIN_THRESHOLD, so it is a genuine AI-modified doc
    expect(classifyEuLabel({ humanChars: 950, observedAiChars: 50 }).label).toBe(EU_LABEL.AI_MODIFIED)
  })

  it('does not over-claim: a mostly-human doc is never AI_GENERATED', () => {
    const r = classifyEuLabel({ humanChars: 400, observedAiChars: 600 })
    expect(r.label).not.toBe(EU_LABEL.AI_GENERATED)
  })

  it('respects the FULLY_AI_THRESHOLD boundary', () => {
    const total = 1000
    const justUnder = classifyEuLabel({
      humanChars: total - Math.ceil(total * FULLY_AI_THRESHOLD) + 1,
      observedAiChars: Math.ceil(total * FULLY_AI_THRESHOLD) - 1,
    })
    expect(justUnder.label).toBe(EU_LABEL.AI_MODIFIED)
  })
})

describe('classifyEuLabel — self-reported-only evidence is hedged, never upgraded to a verdict', () => {
  it('a disclosed-AI-paste-only session is NOT invisible (the undercounting bug) — it classifies, and hedges', () => {
    const r = classifyEuLabel({ humanChars: 0, observedAiChars: 0, selfReportedAiChars: 500 })
    expect(r.label).not.toBe(EU_LABEL.NONE) // the bug: this used to be NONE
    expect(r.label).toBe(EU_LABEL.AI_GENERATED) // 100% self-reported share
    expect(r.evidenceBasis).toBe(EVIDENCE_BASIS.SELF_REPORTED)
    expect(r.reason).toBe(SELF_REPORTED_ONLY_REASON)
  })

  it('uses the SAME hedge text regardless of label/share — never a more confident reason for a higher share', () => {
    const low = classifyEuLabel({ humanChars: 9900, observedAiChars: 0, selfReportedAiChars: 100 })
    const high = classifyEuLabel({ humanChars: 0, observedAiChars: 0, selfReportedAiChars: 1000 })
    expect(low.label).toBe(EU_LABEL.AI)
    expect(high.label).toBe(EU_LABEL.AI_GENERATED)
    expect(low.reason).toBe(SELF_REPORTED_ONLY_REASON)
    expect(high.reason).toBe(SELF_REPORTED_ONLY_REASON)
  })

  it('any system-observed evidence at all, even mixed with self-report, is NOT hedged', () => {
    const r = classifyEuLabel({ humanChars: 0, observedAiChars: 1, selfReportedAiChars: 999 })
    expect(r.evidenceBasis).toBe(EVIDENCE_BASIS.SYSTEM_OBSERVED)
    expect(r.reason).not.toBe(SELF_REPORTED_ONLY_REASON)
  })
})

describe('summariseSession', () => {
  it('ignores rejected AI suggestions entirely', () => {
    const events = [
      { type: 'edit', meta: { char_delta: 100, source: 'human' } },
      { type: 'ai_interaction', meta: { acceptance: 'rejected', ai_chars: 500 } },
    ]
    expect(summariseSession(events)).toEqual({ humanChars: 100, observedAiChars: 0, selfReportedAiChars: 0 })
  })

  it('counts accepted AI characters as observed, not self-reported', () => {
    const events = [
      { type: 'edit', meta: { char_delta: 100, source: 'human' } },
      { type: 'ai_interaction', meta: { acceptance: 'fully_accepted', ai_chars: 200 } },
    ]
    expect(summariseSession(events)).toEqual({ humanChars: 100, observedAiChars: 200, selfReportedAiChars: 0 })
  })

  it('recognizes edit_block — the real producer type (content.js has never emitted the legacy "edit" name)', () => {
    const events = [
      { type: 'edit_block', meta: { char_delta: 100, source: 'human' } },
      { type: 'ai_interaction', meta: { acceptance: 'fully_accepted', ai_chars: 200 } },
    ]
    expect(summariseSession(events)).toEqual({ humanChars: 100, observedAiChars: 200, selfReportedAiChars: 0 })
  })

  it('scales AI characters by similarity_score when the author reworded', () => {
    // AI produced 200 chars but only half its wording survived
    const events = [
      { type: 'ai_interaction', meta: { acceptance: 'modified', ai_chars: 200, similarity_score: 0.5 } },
    ]
    expect(summariseSession(events).observedAiChars).toBe(100)
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
    const empty = { humanChars: 0, observedAiChars: 0, selfReportedAiChars: 0 }
    expect(summariseSession()).toEqual(empty)
    expect(summariseSession([])).toEqual(empty)
  })

  describe('paste events — the undercounting bug and its fix', () => {
    it('a disclosed-AI paste (real source_tool) counts toward selfReportedAiChars, not humanChars', () => {
      const events = [{ type: 'paste', meta: { char_count: 300, source: 'external', source_tool: 'chatgpt' } }]
      expect(summariseSession(events)).toEqual({ humanChars: 0, observedAiChars: 0, selfReportedAiChars: 300 })
    })

    it('an undisclosed paste (no source_tool) counts toward neither bucket', () => {
      const events = [{ type: 'paste', meta: { char_count: 300, source: 'external' } }]
      expect(summariseSession(events)).toEqual({ humanChars: 0, observedAiChars: 0, selfReportedAiChars: 0 })
    })

    it('a paste explicitly self-reported as not_ai counts toward neither bucket', () => {
      const events = [{ type: 'paste', meta: { char_count: 300, source: 'external', source_tool: 'not_ai' } }]
      expect(summariseSession(events)).toEqual({ humanChars: 0, observedAiChars: 0, selfReportedAiChars: 0 })
    })
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

  it('a session that is ENTIRELY one disclosed-AI paste no longer returns NONE (the exact real-world bug)', () => {
    const events = [{ type: 'paste', meta: { char_count: 1200, source: 'external', source_tool: 'claude' } }]
    const result = classifySessionEvents(events)
    expect(result.label).not.toBe(EU_LABEL.NONE)
    expect(result.evidenceBasis).toBe(EVIDENCE_BASIS.SELF_REPORTED)
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
