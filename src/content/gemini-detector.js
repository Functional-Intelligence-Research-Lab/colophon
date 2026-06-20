/**
 * gemini-detector.js — Detects native Google Docs Gemini ("Help me write" /
 * "Refine") suggestions and reports them as TWFF events.
 *
 * Scope (Sprint — Gemini detection)
 * ---------------------------------
 *   IN:  detect when a Gemini suggestion popover appears; capture its text;
 *        detect whether the user accepted (Insert/Replace) or dismissed it;
 *        emit ai_suggestion + ai_interaction events for the timeline + sidebar.
 *   OUT: measuring how much of the suggestion survives in the final document
 *        ("humanised" / partially-modified scoring). That requires reading the
 *        canvas-rendered text (Annotated Canvas) and is a separate, later task.
 *        Until then accepted suggestions are recorded as 'fully_accepted'.
 *
 * Design
 * ------
 *   - Detection is SEMANTIC-first (ARIA roles + accessible button text), with
 *     hashed-class fallbacks isolated in gemini-selectors.js.
 *   - A single MutationObserver on document.body watches the light DOM where
 *     the Gemini popover mounts. (The document *text* is on canvas, but the
 *     Gemini UI chrome is ordinary DOM — so an observer works here.)
 *   - A health-check surfaces silent breakage: if Gemini was available in the
 *     session but we never detected a suggestion, we log a warning so a Google
 *     UI change is visible rather than failing quietly.
 *
 * This module is intentionally framework-free and side-effect-light: callers
 * inject an `emit(event)` function (event = a full TWFF event built by the
 * shared constructors in lib/events.js) so it stays decoupled from content.js's
 * messaging and testable in isolation.
 */

import {
  GEMINI_MODEL_ID,
  classifyAction,
  accessibleName,
  findSuggestionContainer,
  looksLikeGeminiSuggestion,
  geminiAvailable,
} from './gemini-selectors.js'
import { aiSuggestionEvent, aiInteractionEvent } from '../lib/events.js'

const PREVIEW_LIMIT = 100
const CONTEXT_LIMIT = 300
// How long after a suggestion appears we keep listening for an accept/reject
// before assuming it was abandoned (ms). Abandoned suggestions are recorded as
// rejected so the timeline reflects that nothing was inserted.
const ABANDON_MS = 5 * 60 * 1000

export function createGeminiDetector({ emit, log = () => {}, warn = () => {}, onResolve = () => {} }) {
  let _observer = null
  let _active = false
  let _clickHandler = null

  // The suggestion currently shown in the popover, if any.
  // { id, text, appearedAt, resolved }
  let _current = null
  let _abandonTimer = null

  // Health-check bookkeeping.
  let _everDetected = false
  let _geminiSeenAvailable = false

  function start() {
    if (_active) return
    _active = true
    _everDetected = false
    _geminiSeenAvailable = false

    _observer = new MutationObserver(scan)
    _observer.observe(document.body, { childList: true, subtree: true })

    // Capture-phase click listener catches Insert/Replace/Close before Docs
    // tears the popover down.
    _clickHandler = onClickCapture
    document.addEventListener('click', _clickHandler, true)

    // Initial scan in case a popover is already open when recording starts.
    scan()
    log('[Colophon Gemini] detector started')
  }

  function stop() {
    if (!_active) return
    _active = false
    _observer?.disconnect()
    _observer = null
    if (_clickHandler) {
      document.removeEventListener('click', _clickHandler, true)
      _clickHandler = null
    }
    clearTimeout(_abandonTimer)
    // If a suggestion was on screen and never resolved, record it as abandoned.
    if (_current && !_current.resolved) resolveCurrent('rejected', 'session ended with suggestion open')
    _current = null
    runHealthCheck()
    log('[Colophon Gemini] detector stopped')
  }

  // ── Detection ────────────────────────────────────────────────────────────

  function scan() {
    if (!_active) return

    if (!_geminiSeenAvailable && geminiAvailable(document)) {
      _geminiSeenAvailable = true
    }

    const container = findSuggestionContainer(document)
    log('[Colophon Gemini] scan', { container: container?.className ?? null })

    if (container) {
      const text = extractSuggestionText(container)
      log('[Colophon Gemini] extracted text', { len: text.length, preview: text.slice(0, 60) })
      // New suggestion, or the text changed (Refine/regenerate produced a new
      // draft) — treat as a fresh suggestion.
      if (text && (!_current || _current.text !== text)) {
        onSuggestionAppeared(text)
      }
    } else if (_current && !_current.resolved) {
      // The popover went away without a click we recognised. Could be an accept
      // via keyboard or an outside dismissal — leave the abandon timer to
      // resolve it; do nothing here so a transient re-render doesn't misfire.
    }
  }

  function onSuggestionAppeared(text) {
    // Resolve any prior unresolved suggestion as superseded before tracking the
    // new one (e.g. user hit Refine to regenerate).
    if (_current && !_current.resolved) {
      resolveCurrent('rejected', 'superseded by a new suggestion')
    }

    _current = {
      id: nextId(),
      text,
      appearedAt: new Date().toISOString(),
      resolved: false,
    }
    _everDetected = true

    emit(aiSuggestionEvent({
      source: 'ai',
      model: GEMINI_MODEL_ID,
      output_preview: preview(text),
      // Side-panel renderer reads meta.text for the suggestion card:
      text,
      context_window: '', // Sprint: capture surrounding doc context (needs canvas)
      position_start: 0,  // Sprint: real cursor position (needs canvas)
      position_end: 0,
      acceptance: 'pending',
    }))
    log('[Colophon Gemini] suggestion detected', { chars: text.length })

    clearTimeout(_abandonTimer)
    _abandonTimer = setTimeout(() => {
      if (_current && !_current.resolved) {
        resolveCurrent('rejected', 'suggestion abandoned (timeout)')
      }
    }, ABANDON_MS)
  }

  // ── Accept / reject ────────────────────────────────────────────────────────

  function onClickCapture(e) {
    // _current is the meaningful guard: it is only set while a suggestion is on
    // screen, and stop() clears it. (No _active check so the logic is testable
    // without starting the observer.)
    log('[Colophon Gemini] click', { hasCurrent: !!_current, target: e.target?.className ?? null })
    if (!_current || _current.resolved) return

    // Walk up from the click target to find a button/role=button with a
    // recognised accept/reject accessible name.
    let node = e.target
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      // Duck-typed element check (works in tests without a DOM): needs the
      // getAttribute/textContent surface that classifyAction reads.
      if (typeof node.getAttribute !== 'function') continue
      const name = accessibleName(node)
      const action = classifyAction(node)
      log('[Colophon Gemini] click walk', { i, tag: node.tagName, name, action })
      if (action === 'accept') {
        resolveCurrent('fully_accepted', null, node)
        return
      }
      if (action === 'reject') {
        resolveCurrent('rejected', `user clicked "${accessibleName(node)}"`)
        return
      }
    }
  }

  function resolveCurrent(acceptance, reason, _actionEl) {
    if (!_current || _current.resolved) return
    _current.resolved = true
    clearTimeout(_abandonTimer)

    const accepted = acceptance === 'fully_accepted'
    emit(aiInteractionEvent({
      source: 'ai',
      model: GEMINI_MODEL_ID,
      output_preview: preview(_current.text),
      // For accepted suggestions we know the inserted text; show it as the
      // "after" side of the diff card. content_before is unknown without canvas
      // access, so leave it empty (renderer handles the placeholder).
      content_before: '',
      content_after: accepted ? _current.text : '',
      position_start: 0, // Sprint: real cursor position (needs canvas)
      position_end: 0,
      acceptance,
      // ai_chars: characters from the AI output retained. Without canvas-level
      // diffing we record the full length on accept, 0 on reject. Similarity /
      // "humanised" scoring is a later task that will refine this.
      ai_chars: accepted ? _current.text.length : 0,
      ...(reason ? { reason } : {}),
    }))
    log('[Colophon Gemini] suggestion resolved', { acceptance, reason: reason ?? null })

    // Tell the host (content.js) so it can suppress the edit/paste capture that
    // Docs fires when the accepted text is inserted — otherwise AI-authored text
    // would also be logged as a human edit (double counting / misattribution).
    onResolve({ acceptance, accepted, chars: _current.text.length })
  }

  // ── Health check ────────────────────────────────────────────────────────────

  function runHealthCheck() {
    // If Gemini was clearly available to the user but we never detected a single
    // suggestion, our selectors may have drifted. Surface it loudly so it gets
    // fixed in gemini-selectors.js rather than failing silently.
    if (_geminiSeenAvailable && !_everDetected) {
      warn(
        '[Colophon Gemini] Gemini UI was present this session but no suggestion ' +
        'was ever detected. Selectors in gemini-selectors.js may need updating.',
      )
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function extractSuggestionText(container) {
    if (!container || !looksLikeGeminiSuggestion(container)) return ''
    // For the Barkick bar the response prose lives in a specific sub-container.
    // Scoping to it avoids picking up the user's own prompt text (which lives in
    // a sibling input area in the same outer wrapper).
    const responseArea = container.querySelector?.('.appsElementsSidekickBarkickTopBoxResponseContainerOneSystem') ?? container
    const clone = responseArea.cloneNode(true)
    // Strip interactive controls and the icon/controls top-row so only prose remains.
    clone.querySelectorAll(
      'button, [role="button"], textarea, input, .appsElementsSidekickBarkickTopBoxResponseTopRow'
    ).forEach(n => n.remove())
    const text = (clone.textContent ?? '').trim().replace(/\s+/g, ' ')
    return text
  }

  function preview(text) {
    return text.length > PREVIEW_LIMIT ? text.slice(0, PREVIEW_LIMIT) + '...' : text
  }

  let _idSeq = 0
  function nextId() {
    _idSeq += 1
    return `gemini-${_idSeq}`
  }

  // Exposed for unit testing without a real DOM/observer.
  return {
    start,
    stop,
    // test seams:
    _onSuggestionAppeared: onSuggestionAppeared,
    _onClickCapture: onClickCapture,
    _scan: scan,
    get _state() {
      return { current: _current, everDetected: _everDetected, active: _active }
    },
  }
}

// Re-exported for callers/tests that want the constants without a second import.
export { GEMINI_MODEL_ID, PREVIEW_LIMIT, CONTEXT_LIMIT, ABANDON_MS }
