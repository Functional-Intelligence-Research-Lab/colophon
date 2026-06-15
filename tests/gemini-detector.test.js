/**
 * gemini-detector.test.js
 *
 * Tests the pure event-emission logic of the native-Gemini suggestion detector
 * via its test seams (no real DOM/MutationObserver needed). DOM selector
 * matching lives in gemini-selectors.js and is covered separately.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createGeminiDetector } from '../src/content/gemini-detector.js'
import {
  classifyAction,
  looksLikeGeminiSuggestion,
  matchesAny,
  ACCEPT_LABELS,
  REJECT_LABELS,
} from '../src/content/gemini-selectors.js'

// Minimal fake element implementing just what the detector/selectors read.
function fakeEl({ ariaLabel = '', text = '', buttons = [] } = {}) {
  return {
    getAttribute: name => (name === 'aria-label' ? ariaLabel : null),
    textContent: text,
    querySelectorAll: () => buttons,
    parentElement: null,
  }
}

describe('gemini-selectors classification', () => {
  it('matches accept labels exactly, not as substrings', () => {
    expect(matchesAny('insert', ACCEPT_LABELS)).toBe(true)
    expect(matchesAny('replace', ACCEPT_LABELS)).toBe(true)
    // "disclose" must not match "close"
    expect(matchesAny('disclose', REJECT_LABELS)).toBe(false)
    expect(matchesAny('close', REJECT_LABELS)).toBe(true)
  })

  it('classifies accept / reject from accessible name', () => {
    expect(classifyAction(fakeEl({ text: 'Insert' }))).toBe('accept')
    expect(classifyAction(fakeEl({ ariaLabel: 'Replace' }))).toBe('accept')
    expect(classifyAction(fakeEl({ text: 'Close' }))).toBe('reject')
    expect(classifyAction(fakeEl({ text: 'Something else' }))).toBe(null)
  })

  it('only treats a container as Gemini when it has a Gemini cue', () => {
    const withGeminiName = fakeEl({ ariaLabel: 'Gemini suggestion' })
    expect(looksLikeGeminiSuggestion(withGeminiName)).toBe(true)

    const withAcceptButton = fakeEl({
      text: 'Some draft text',
      buttons: [fakeEl({ text: 'Insert' })],
    })
    expect(looksLikeGeminiSuggestion(withAcceptButton)).toBe(true)

    const unrelated = fakeEl({ text: 'A normal dialog', buttons: [fakeEl({ text: 'OK' })] })
    expect(looksLikeGeminiSuggestion(unrelated)).toBe(false)
  })
})

describe('createGeminiDetector emission', () => {
  let emitted
  let resolves
  let detector

  beforeEach(() => {
    emitted = []
    resolves = []
    detector = createGeminiDetector({
      // emit now receives a full TWFF event { type, timestamp, meta }.
      emit: event => emitted.push(event),
      onResolve: info => resolves.push(info),
    })
  })

  it('emits ai_suggestion when a suggestion appears', () => {
    detector._onSuggestionAppeared('Draft text from Gemini')
    expect(emitted).toHaveLength(1)
    expect(emitted[0].type).toBe('ai_suggestion')
    // timestamp must be a real ISO string, not a function (events.js bug guard)
    expect(typeof emitted[0].timestamp).toBe('string')
    expect(emitted[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(emitted[0].meta.model).toBe('google/gemini')
    expect(emitted[0].meta.source).toBe('ai')
    expect(emitted[0].meta.acceptance).toBe('pending')
    expect(emitted[0].meta.text).toBe('Draft text from Gemini')
    expect(emitted[0].meta.output_preview).toBe('Draft text from Gemini')
  })

  it('truncates long previews to 100 chars + ellipsis but keeps full text', () => {
    const long = 'x'.repeat(250)
    detector._onSuggestionAppeared(long)
    const meta = emitted[0].meta
    expect(meta.text).toBe(long)
    expect(meta.output_preview).toBe('x'.repeat(100) + '...')
  })

  it('emits ai_interaction fully_accepted on Insert click', () => {
    detector._onSuggestionAppeared('Accept me')
    detector._onClickCapture({ target: fakeClickEl('Insert') })

    const interaction = emitted.find(e => e.type === 'ai_interaction')
    expect(interaction).toBeTruthy()
    expect(interaction.meta.acceptance).toBe('fully_accepted')
    expect(interaction.meta.content_after).toBe('Accept me')
    expect(interaction.meta.ai_chars).toBe('Accept me'.length)
    // host notified so it can suppress the insertion edit
    expect(resolves).toEqual([{ acceptance: 'fully_accepted', accepted: true, chars: 9 }])
  })

  it('emits ai_interaction rejected on Close click with ai_chars 0', () => {
    detector._onSuggestionAppeared('Reject me')
    detector._onClickCapture({ target: fakeClickEl('Close') })

    const interaction = emitted.find(e => e.type === 'ai_interaction')
    expect(interaction.meta.acceptance).toBe('rejected')
    expect(interaction.meta.ai_chars).toBe(0)
    expect(interaction.meta.content_after).toBe('')
    expect(resolves[0].accepted).toBe(false)
  })

  it('does not double-resolve on a second click', () => {
    detector._onSuggestionAppeared('Once')
    detector._onClickCapture({ target: fakeClickEl('Insert') })
    detector._onClickCapture({ target: fakeClickEl('Close') })
    const interactions = emitted.filter(e => e.type === 'ai_interaction')
    expect(interactions).toHaveLength(1)
    expect(interactions[0].meta.acceptance).toBe('fully_accepted')
  })

  it('supersedes an unresolved suggestion when a new one appears (Refine)', () => {
    detector._onSuggestionAppeared('First draft')
    detector._onSuggestionAppeared('Refined draft')

    const interactions = emitted.filter(e => e.type === 'ai_interaction')
    const suggestions = emitted.filter(e => e.type === 'ai_suggestion')
    expect(suggestions).toHaveLength(2)
    // first one auto-resolved as rejected/superseded
    expect(interactions).toHaveLength(1)
    expect(interactions[0].meta.acceptance).toBe('rejected')
    expect(interactions[0].meta.reason).toMatch(/superseded/i)
  })

  it('ignores clicks on unrelated buttons', () => {
    detector._onSuggestionAppeared('Draft')
    detector._onClickCapture({ target: fakeClickEl('Bold') })
    expect(emitted.filter(e => e.type === 'ai_interaction')).toHaveLength(0)
  })
})

// A click target that walks up via parentElement and exposes accessible name.
// Duck-typed (getAttribute + textContent) to match the detector's guard.
function fakeClickEl(label) {
  return {
    getAttribute: () => null,
    textContent: label,
    parentElement: null,
  }
}
