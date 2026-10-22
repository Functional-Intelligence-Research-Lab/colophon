/**
 * gemini-selectors-dom.test.js
 *
 * Regression coverage for the false "Gemini proposed changes" notification
 * bug: the global `document` stub in tests/setup.js always returns null from
 * querySelector, so gemini-selectors.js's real selector-matching logic
 * (findSuggestionContainer walking SUGGESTION_CONTAINER_SELECTORS against an
 * actual element tree) had zero test coverage — including the two concrete
 * false-positive shapes that reached real users: an ordinary human
 * Suggest-mode comment (not Gemini at all) and an empty "Help me write"
 * prompt box with no draft yet. This file builds a tiny, local, class/attr-
 * selector-aware element tree (not a full DOM) to exercise that logic for
 * real, independent of the global stub.
 */

import { describe, it, expect } from 'vitest'
import { findSuggestionContainer, looksLikeGeminiSuggestion } from '../src/content/gemini-selectors.js'

// ── Minimal selector-aware fake element tree ──────────────────────────────
// Supports exactly what gemini-selectors.js's selector lists use: class
// (.foo), id (#foo), attribute-exists/exact/contains([attr], [attr="v"],
// [attr*="v" i]), and compound bracket selectors — no combinators, since
// none of the real selector lists use them.

function parseSimpleSelector(sel) {
  const tokens = sel.match(/\.[\w-]+|#[\w-]+|\[[^\]]+\]/g) || []
  return tokens.map(tok => {
    if (tok.startsWith('.')) return { type: 'class', value: tok.slice(1) }
    if (tok.startsWith('#')) return { type: 'id', value: tok.slice(1) }
    const m = tok.slice(1, -1).match(/^([\w-]+)(?:([*^$]?=)"([^"]*)")?\s*(i)?$/)
    return { type: 'attr', name: m[1], op: m[2] || null, value: m[3] ?? null, ci: !!m[4] }
  })
}

function matchesToken(el, token) {
  if (token.type === 'class') return el.classList.has(token.value)
  if (token.type === 'id') return el._id === token.value
  const raw = el.getAttribute(token.name)
  if (raw == null) return false
  if (!token.op) return true
  const a = token.ci ? raw.toLowerCase() : raw
  const b = token.ci ? token.value.toLowerCase() : token.value
  if (token.op === '=') return a === b
  if (token.op === '*=') return a.includes(b)
  if (token.op === '^=') return a.startsWith(b)
  if (token.op === '$=') return a.endsWith(b)
  return false
}

class FakeElement {
  constructor({ tag = 'div', id = '', classes = [], attrs = {}, text = '' } = {}, children = []) {
    this.tagName = tag.toUpperCase()
    this._id = id
    this.classList = { contains: c => classes.includes(c), has: c => classes.includes(c) }
    this._attrs = attrs
    this._text = text
    this.children = children
  }
  getAttribute(name) { return this._attrs[name] ?? null }
  get textContent() {
    return this._text + this.children.map(c => c.textContent).join('')
  }
  matches(sel) { return parseSimpleSelector(sel).every(t => matchesToken(this, t)) }
  querySelectorAll(sel) {
    const out = []
    const walk = node => { for (const c of node.children) { if (c.matches(sel)) out.push(c); walk(c) } }
    walk(this)
    return out
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null }
}

const el = (spec, children) => new FakeElement(spec, children)

describe('findSuggestionContainer / looksLikeGeminiSuggestion — realistic DOM shapes', () => {
  it('finds a real Gemini Barkick suggestion (true positive)', () => {
    const root = el({}, [
      el({ classes: ['appsElementsSidekickBarkickTopBox'] }, [
        el({ classes: ['appsElementsSidekickBarkickTopBoxResponseOneSystem'], text: 'A drafted paragraph.' }),
        el({ tag: 'button', text: 'Insert' }),
      ]),
    ])
    const container = findSuggestionContainer(root)
    expect(container).toBeTruthy()
    expect(looksLikeGeminiSuggestion(container)).toBe(true)
  })

  it('finds a real anchored Gemini diff card (true positive)', () => {
    const root = el({}, [
      el({ classes: ['docos-anchoreddocoview'] }, [
        el({ classes: ['docosAiPreviewDiffVisibleSuggestionViewContent'], text: 'Proposed replacement text.' }),
      ]),
    ])
    const container = findSuggestionContainer(root)
    expect(container).toBeTruthy()
    expect(looksLikeGeminiSuggestion(container)).toBe(true)
  })

  it('does NOT treat an ordinary human Suggest-mode comment as a Gemini suggestion', () => {
    // A real human tracked-change bubble: same .docos-anchoreddocoview wrapper
    // Google Docs itself uses, with generic "Accept suggestion"/"Reject
    // suggestion" buttons — no Gemini-specific class or label anywhere.
    const root = el({}, [
      el({ classes: ['docos-anchoreddocoview'] }, [
        el({ text: 'Maybe cite a source here?' }),
        el({ tag: 'button', text: 'Accept suggestion' }),
        el({ tag: 'button', text: 'Reject suggestion' }),
      ]),
    ])
    const container = findSuggestionContainer(root)
    expect(container).toBeFalsy()
  })

  it('does NOT treat a generic Docs dialog (e.g. insert-image/insert-table) as Gemini', () => {
    const root = el({}, [
      el({ attrs: { role: 'dialog' } }, [
        el({ text: 'Insert table' }),
        el({ tag: 'button', text: 'Insert' }),
        el({ tag: 'button', text: 'Cancel' }),
      ]),
    ])
    const container = findSuggestionContainer(root)
    expect(container).toBeFalsy()
  })

  it('still recognises an empty "Help me write" prompt box as Gemini UI by label alone', () => {
    // No draft text yet, no accept button yet — but the label is Gemini-specific
    // enough to trust. extractSuggestionText (gemini-detector.js) is responsible
    // for returning no content here, not this selector layer.
    const container = el({ attrs: { 'aria-label': 'Help me write' } }, [])
    expect(looksLikeGeminiSuggestion(container)).toBe(true)
  })

  it('does not trust "Gemini" alone without a specific feature cue', () => {
    // E.g. an "Ask Gemini" side-panel entry button or menu item — present in
    // the chrome whenever Gemini exists at all, not specific to a suggestion.
    const container = el({ attrs: { 'aria-label': 'Ask Gemini' } }, [])
    expect(looksLikeGeminiSuggestion(container)).toBe(false)
  })
})
