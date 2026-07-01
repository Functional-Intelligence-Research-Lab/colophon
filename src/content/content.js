import { mountColophonPanel } from '../panel/app.js'
import { createGeminiDetector } from './gemini-detector.js'
import { createVelocityTracker, isTooFastForHuman } from './edit-velocity.js'
import { classifyInsertion } from './block-insertion.js'
import { analyzeText } from '../lib/heuristics.js'
import { aiInteractionEvent } from '../lib/events.js'
import { isMetaCommentary, GEMINI_MODEL_ID, extractGeminiProposedDiff } from './gemini-selectors.js'

/**
 * content.js — Colophon content script
 *
 * Injected into https://docs.google.com/document/*
 *
 * Design: dormant by default. Observers only activate when the service
 * worker sends ACTIVATE (i.e. after the user clicks "Start recording").
 *
 * Edit detection strategy:
 *   Google Docs uses a canvas-based renderer — text is painted on <canvas>,
 *   so MutationObserver on the visible DOM never fires for typing. Instead
 *   we listen to 'keydown' on the document, which fires reliably regardless
 *   of renderer. Keystrokes are debounced into aggregated edit events.
 *   MutationObserver is kept as a secondary signal for non-canvas paths.
 *
 * Message protocol:
 *   SW → content:  { type: 'ACTIVATE' }
 *   SW → content:  { type: 'DEACTIVATE' }
 *   content → SW:  { type: 'LOG_EVENT', payload: TwffEvent }
 */

const DEBOUNCE_MS     = 1000
const EDITOR_SELECTOR = '.kix-appview-editor'
const TEXT_EVENT_IFRAME_SELECTOR = 'iframe.docs-texteventtarget-iframe'
const EDITOR_POLL_MS  = 800
const PREVIEW_LIMIT   = 100
const PASTE_SUPPRESSION_MS = 1500

// Keys that don't produce or remove characters — skip these
const SKIP_KEYS = new Set([
  'Alt', 'AltGraph', 'CapsLock', 'Control', 'Fn', 'FnLock',
  'Meta', 'NumLock', 'ScrollLock', 'Shift',
  'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp',
  'End', 'Home', 'PageDown', 'PageUp',
  'Escape', 'Tab', 'Insert', 'ContextMenu',
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
])

let _active     = false
let _observer   = null
let _editBuffer = null
let _debounce   = null
let _blurredAt  = null
let _lastPasteAt = 0
let _pendingPaste = null
let _listenerTargets = []
let _lastInternalCopy = null  // tracks text copied from within the doc to skip internal paste logging
let _heuristicDebounce = null
let _floatingPanel = null
let _floatingPinned = false
let _checkpointTimer = null
let _selectionDebounce = null
let _rollingBaselineState = "";
let _baselineTimer = null;
let _isFetchingBaseline = false;
let _lastSnapshotTime = 0;
let _bufferStartTime = 0;
let _geminiPanelActive = false;
let _geminiObserver = null;
// Snapshot taken the moment a Gemini suggestion appears (used as the
// pre-change baseline when computing what the AI actually inserted).
let _preSuggestionSnapshot = null;

function extractTextFromModelChunks() {
  try {
    const scripts = Array.from(document.querySelectorAll('script'));
    let combined = '';
    for (const script of scripts) {
      const content = script.textContent || '';
      if (content.includes('DOCS_modelChunk')) {
        const matches = content.match(/"s"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
        if (matches) {
          for (const m of matches) {
            try {
              const jsonVal = JSON.parse('{' + m + '}');
              if (jsonVal.s && jsonVal.s.length > 20) {
                combined += jsonVal.s + '\n';
              }
            } catch { /* ignore */ }
          }
        }
      }
    }
    return combined.trim();
  } catch {
    return '';
  }
}

function _getDocText() {
  let nodes = Array.from(document.querySelectorAll('.kix-paragraphrenderer'));
  if (nodes.length === 0 || nodes.every(n => !n.textContent.trim())) {
    nodes = Array.from(document.querySelectorAll('.kix-lineview, .kix-wordhtmlgenerator-word-node, [role="document"] p, .kix-page p, .kix-page span'));
  }
  if (nodes.length > 0) {
    const text = nodes.map(p => p.textContent).join('\n').trim();
    if (text) return text.slice(0, 25000);
  }
  const chunkText = extractTextFromModelChunks();
  if (chunkText) return chunkText.slice(0, 25000);

  return _rollingBaselineState || "";
}

function _pushDocContext() {
  const paras = Array.from(document.querySelectorAll('.kix-paragraphrenderer'))
  const text = paras.map(p => p.textContent).join('\n')
  const cursorEl = document.querySelector('.kix-cursor')
  let cursorIndex = text.length
  if (cursorEl) {
    const cursorPara = cursorEl.closest('.kix-paragraphrenderer')
    if (cursorPara) {
      let offset = 0
      for (const para of paras) {
        if (para === cursorPara) break
        offset += para.textContent.length + 1
      }
      cursorIndex = offset
    }
  }
  const selectedText = window.getSelection()?.toString().trim() ?? ''
  chrome.runtime.sendMessage({
    action: 'UPDATE_DOC_CONTEXT',
    payload: { text, cursorIndex, selectedText },
  }).catch(() => {})
}

let _docContextDebounce = null
function _schedulePushDocContext() {
  clearTimeout(_docContextDebounce)
  _docContextDebounce = setTimeout(_pushDocContext, 1000)
}

function onSelectionChange() {
  clearTimeout(_selectionDebounce)
  _selectionDebounce = setTimeout(() => {
    const text = window.getSelection()?.toString().trim() ?? ''
    if (text.length < 10) {
      chrome.runtime.sendMessage({ action: 'SELECTION_CHANGED', payload: { text: '' } }).catch(() => {})
      _pushDocContext()
      return
    }
    const doc = _getDocText()
    const idx = doc.indexOf(text.slice(0, 50))
    const context_before = idx >= 0 ? doc.slice(Math.max(0, idx - 300), idx) : ''
    const context_after  = idx >= 0 ? doc.slice(idx + text.length, idx + text.length + 300) : ''
    chrome.runtime.sendMessage({
      action: 'SELECTION_CHANGED',
      payload: { text, context_before, context_after },
    }).catch(() => {})
    _pushDocContext()
  }, 600)
}

// Native Google Docs Gemini ("Help me write" / "Refine") suggestion detector.
// Emits ai_suggestion / ai_interaction events via the same send() path as edits.
const _geminiDetector = createGeminiDetector({
  emit: event => send('LOG_EVENT', event),
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  emitInteractions: false,

  // Called the instant a Gemini suggestion popover appears — before the user
  // has accepted or rejected. We grab a fresh, cache-busted doc snapshot here
  // so we have a reliable "before" baseline for the diff on acceptance.
  onSuggestionWillAppear: () => {
    console.log('[Colophon Gemini] Pre-suggestion snapshot starting...');
    getDocumentText().then(t => {
      if (t) {
        _preSuggestionSnapshot = t;
        console.log('[Colophon Gemini] Pre-suggestion snapshot captured', { chars: t.length });
      }
    }).catch(() => {});
  },

  onResolve: ({ acceptance, accepted, chars, suggestionText, reason }) => {
    if (accepted) {
      _lastPasteAt = Date.now();
      _pendingPaste = { startedAt: Date.now(), text: '', logged: true };

      // Use the snapshot taken when the suggestion appeared; fall back to the
      // rolling baseline if the per-suggestion snapshot wasn't ready in time.
      const docBefore = _preSuggestionSnapshot || _rollingBaselineState || _getDocText();
      const domDiff = extractGeminiProposedDiff();

      // Poll the export API (with cache-busting) until the document text
      // actually differs from the pre-suggestion snapshot. This handles the
      // typical 5–15 s lag between Google Docs autosaving and the export
      // endpoint reflecting the change.
      pollForDocChange(docBefore).then(docAfter => {
        const diff = docAfter ? computeDocumentDiff(docBefore, docAfter) : { addedText: '', removedText: '' };

        const commentary = isMetaCommentary(suggestionText);
        const finalAdded = diff.addedText || domDiff.insertedText || (!commentary ? suggestionText : '');
        const finalRemoved = diff.removedText || domDiff.deletedText || '';

        console.log('[Colophon Gemini] onResolve diff result', {
          addedChars: finalAdded.length,
          removedChars: finalRemoved.length,
          source: diff.addedText ? 'export-diff' : domDiff.insertedText ? 'dom-diff' : 'suggestion-text',
        });

        send('LOG_EVENT', aiInteractionEvent({
          source: 'ai',
          model: GEMINI_MODEL_ID,
          output_preview: finalAdded.length > 0 ? finalAdded.slice(0, 100) : (commentary ? suggestionText.slice(0, 100) : ''),
          content_before: finalRemoved,
          content_after: finalAdded,
          position_start: 0,
          position_end: 0,
          acceptance,
          ai_chars: finalAdded.length,
          ...(reason ? { reason } : {})
        }));

        if (docAfter) _rollingBaselineState = docAfter;
        _preSuggestionSnapshot = null; // reset for next suggestion
      });
    } else {
      _preSuggestionSnapshot = null; // dismissed — discard the snapshot
      send('LOG_EVENT', aiInteractionEvent({
        source: 'ai',
        model: GEMINI_MODEL_ID,
        output_preview: suggestionText ? suggestionText.slice(0, 100) : '',
        content_before: '',
        content_after: '',
        position_start: 0,
        position_end: 0,
        acceptance,
        ai_chars: 0,
        ...(reason ? { reason } : {})
      }));
    }
  },
})

// ── Bootstrap ─────────────────────────────────────────────────────────────────

console.log('[Colophon] Content script injected on', location.pathname)
console.log('[Colophon Content] injected', {
  path: location.pathname,
  readyState: document.readyState,
  hasEditor: !!document.querySelector(EDITOR_SELECTOR),
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    if (msg.type === 'ACTIVATE')   { console.log('[Colophon Content] ACTIVATE message'); activate() }
    if (msg.type === 'DEACTIVATE') { console.log('[Colophon Content] DEACTIVATE message'); deactivate() }
    if (msg.action === 'CLEAR_SELECTION') {
      clearTimeout(_selectionDebounce)
      window.getSelection()?.removeAllRanges()
      sendResponse({ ok: true })
    }
    if (msg.type === 'TOGGLE_FLOATING_PANEL') {
      toggleFloatingPanel()
      sendResponse({ ok: true, open: !!_floatingPanel })
    }
    if (msg.type === '__PING__')   sendResponse({ ok: true, active: _active })
    if (msg.action === 'FETCH_DOC_EXPORT') {
      console.log('[Colophon Content] FETCH_DOC_EXPORT requested for format:', msg.format);
      forceFetchExport(msg.docId, msg.format)
        .then(data => sendResponse(data))
        .catch(err => sendResponse({ error: err.message }));
      return true; // Tells Chrome we will send the response asynchronously
    }
    if (msg.action === 'GET_TITLE') {
      sendResponse({ title: getDocsTitle() });
    }

    if (msg.action === 'APPLY_SUGGESTION') {
      insertTextIntoDocs(msg.text)
        .then(() => sendResponse({ status: "success" }))
        .catch(err => sendResponse({ status: "error", message: err.message }));
      return true; // Tells Chrome we will send the response asynchronously
    }

    // Programmatically click the native Gemini "Insert" / "Replace" button so the
    // sidepanel can drive the accept action without the user having to reach back
    // to the Gemini popover in the document.
    if (msg.action === 'GEMINI_ACCEPT') {
      const btn = findGeminiActionButton('accept');
      if (btn) {
        btn.click();
        sendResponse({ status: 'ok' });
      } else {
        sendResponse({ status: 'error', message: 'Gemini accept button not found' });
      }
      return true;
    }

    // Programmatically click the native Gemini "Close" / "Cancel" button.
    if (msg.action === 'GEMINI_REJECT') {
      const btn = findGeminiActionButton('reject');
      if (btn) {
        btn.click();
        sendResponse({ status: 'ok' });
      } else {
        sendResponse({ status: 'error', message: 'Gemini reject button not found' });
      }
      return true;
    }

    if (msg.action === 'GET_EDITOR_TEXT') {
      const paras = Array.from(document.querySelectorAll('.kix-paragraphrenderer'));
      const text = paras.map(p => p.textContent).join('\n');
      // Try to locate cursor position by paragraph
      const cursorEl = document.querySelector('.kix-cursor');
      let cursorIndex = text.length;
      if (cursorEl) {
        const cursorPara = cursorEl.closest('.kix-paragraphrenderer');
        if (cursorPara) {
          let offset = 0;
          for (const para of paras) {
            if (para === cursorPara) break;
            offset += para.textContent.length + 1;
          }
          cursorIndex = offset;
        }
      }
      sendResponse({ text, cursorIndex });
    }

    if (msg.action === 'FORCE_SCAN') {
      clearTimeout(_baselineTimer);
      updateRollingBaseline(sendResponse);
      return true; // async response
    }

    if (msg.action === 'GET_SNAPSHOT_AGE') {
      sendResponse({ ok: true, ageMs: _lastSnapshotTime ? Date.now() - _lastSnapshotTime : Infinity });
    }
  } catch (err) {
    if (err.message?.includes('Extension context invalidated')) {
      console.warn('[Colophon] Extension context invalidated — ignoring message:', msg.action || msg.type);
    } else {
      console.error('[Colophon] Error handling message:', err);
    }
  }
})

syncRecordingState()
document.addEventListener('selectionchange', onSelectionChange)
document.addEventListener('mouseup', onSelectionChange)
document.addEventListener('keyup', _schedulePushDocContext)
window.addEventListener('blur', _pushDocContext)

// ── Activation ────────────────────────────────────────────────────────────────

function activate() {
  if (_active) {
    console.log('[Colophon Content] activate skipped: already active')
    return
  }
  _active = true
  attachInputListeners(document, 'top-document')
  watchTextEventIframe()
  // Secondary: MutationObserver (works in legacy/non-canvas renderer)
  waitForEditor(attachObserver)
  // Native Gemini suggestion detection (Help me write / Refine)
  _geminiDetector.start()
  document.addEventListener('visibilitychange', onVisibilityChange)
  // Periodic checkpoints every 5 minutes + heuristic pass
  _checkpointTimer = setInterval(() => {
    const text = _getDocText()
    const words = text.trim().split(/\s+/).filter(Boolean).length
    chrome.runtime.sendMessage({
      action: 'LOG_EVENT',
      payload: {
        type: 'checkpoint',
        timestamp: new Date().toISOString(),
        meta: { char_count_total: text.length, word_count_total: words },
      },
    }).catch(() => {})
    runHeuristics()
  }, 5 * 60 * 1000)
  console.log('[Colophon Content] recording activated', {
    activeElement: describeElement(document.activeElement),
    hasEditor: !!document.querySelector(EDITOR_SELECTOR),
  })

  // Capture the document's current state as a pre-session baseline (no Drive API needed)
  getDocumentText().then(preText => {
    if (preText) {
      chrome.runtime.sendMessage({
        action: 'SET_PRE_SESSION_TEXT',
        payload: { text: preText.slice(0, 20000) },
      }).catch(() => {})
    }
  }).catch(() => {})
}

function runHeuristics() {
  const text = _getDocText()
  if (!text || text.trim().length < 30) return
  const tips = analyzeText(text)
  for (const tip of tips) {
    chrome.runtime.sendMessage({
      action: 'LOG_EVENT',
      payload: {
        type: 'heuristic_suggestion',
        timestamp: new Date().toISOString(),
        meta: { rule: tip.rule, text: tip.text, excerpt: tip.excerpt },
      },
    }).catch(() => {})
  }
}

function scheduleHeuristics() {
  clearTimeout(_heuristicDebounce)
  _heuristicDebounce = setTimeout(runHeuristics, 30_000)
}

function describeElement(el) {
  if (!el) return null
  return {
    tag: el.tagName?.toLowerCase() ?? '',
    id: el.id ?? '',
    className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
    role: el.getAttribute?.('role') ?? '',
    contenteditable: el.getAttribute?.('contenteditable') ?? '',
  }
}

function attachInputListeners(target, label) {
  if (!target || _listenerTargets.some(item => item.target === target)) return
  target.addEventListener('keydown', onKeydown, true)
  target.addEventListener('paste', onPaste, true)
  target.addEventListener('copy', onCopy, true)
  target.addEventListener('input', onInput, true)
  _listenerTargets.push({ target, label })
  console.log('[Colophon Content] input listeners attached', { label })
}

function detachInputListeners() {
  for (const { target, label } of _listenerTargets) {
    target.removeEventListener('keydown', onKeydown, true)
    target.removeEventListener('paste', onPaste, true)
    target.removeEventListener('copy', onCopy, true)
    target.removeEventListener('input', onInput, true)
    console.log('[Colophon Content] input listeners detached', { label })
  }
  _listenerTargets = []
}

function watchTextEventIframe() {
  if (!_active) return
  attachTextEventIframe()
  setTimeout(watchTextEventIframe, EDITOR_POLL_MS)
}

function attachTextEventIframe() {
  const frames = [
    ...document.querySelectorAll(TEXT_EVENT_IFRAME_SELECTOR),
    ...document.querySelectorAll('iframe[aria-hidden="true"]'),
  ]
  for (const frame of frames) {
    try {
      const doc = frame.contentDocument
      if (!doc) continue
      attachInputListeners(doc, 'docs-text-iframe-document')
    } catch (err) {
      console.log('[Colophon Content] text iframe inaccessible', {
        frame: describeElement(frame),
        error: err.message,
      })
    }
  }
}

// Always-on recording (spike). When true, a Doc load auto-starts a session so
// text written before any "Start recording" click is still captured — closing
// the opt-in blind spot. Flip to false to revert to manual/opt-in recording.
const AUTO_RECORD = true

async function syncRecordingState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
    console.log('[Colophon Content] sync recording state', {
      hasSession: !!state?.session,
      isRecording: !!state?.session?.isRecording,
    })
    if (state?.session?.isRecording) {
      activate()
      return
    }
    if (AUTO_RECORD) {
      // SW derives tab/url from the sender and won't clobber a live session.
      const res = await chrome.runtime.sendMessage({ type: 'AUTO_SESSION_START' })
      console.log('[Colophon Content] auto-record requested', res)
      if (res?.ok) activate()
    }
  } catch {
    // Popup activation remains the fallback path if the service worker is waking.
  }
}

function deactivate() {
  if (!_active) return
  _active = false
  detachInputListeners()
  _geminiDetector.stop()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  clearTimeout(_selectionDebounce)
  _observer?.disconnect()
  _observer = null
  clearTimeout(_debounce)
  clearInterval(_checkpointTimer)
  _checkpointTimer = null
  flushEdit() // flush anything buffered before stopping
  _editBuffer = null
  console.log('[Colophon Content] recording deactivated')
}

// ── Extension context guard ───────────────────────────────────────────────────
// After a reload, kix_core may still call into our DOM listeners. Detect the
// invalidated context early and self-remove all listeners to stop the cascade.

function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

// ── Edit capture: keydown (primary) ──────────────────────────────────────────

function isTargetingFormInput(target) {
  if (!target) return false;
  const tag = target.tagName?.toUpperCase() ?? '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (target.closest?.('.appsElementsSidekickBarkickTopBox, [role="dialog"], .docos-anchoreddocoview, #colophon-panel')) return true;
  return false;
}

function onKeydown(e) {
  if (!isContextValid()) { detachInputListeners(); return; }
  if (!_active) return
  if (isTargetingFormInput(e.target)) return;
  if (SKIP_KEYS.has(e.key)) {
    console.log('[Colophon Content] keydown skipped', { reason: 'skip-key', key: e.key })
    return
  }
  if (e.ctrlKey || e.metaKey) {
    console.log('[Colophon Content] keydown skipped', { reason: 'shortcut', code: e.code })
    return
  }

  // Backspace/Delete remove a character; everything else adds one
  const isDelete = (e.key === 'Backspace' || e.key === 'Delete')
  const delta = isDelete ? -1 : 1
  console.log('[Colophon Content] keydown captured', { code: e.code, delta, target: describeElement(e.target) })
  bufferEdit(delta, isDelete)
  scheduleHeuristics()
}

// ── Edit capture: MutationObserver (secondary) ────────────────────────────────

function waitForEditor(callback) {
  const el = document.querySelector(EDITOR_SELECTOR)
  if (el) { callback(el); return }
  console.log('[Colophon Content] waiting for editor', { selector: EDITOR_SELECTOR })
  setTimeout(() => waitForEditor(callback), EDITOR_POLL_MS)
}

function attachObserver(editor) {
  _observer = new MutationObserver(onMutation)
  _observer.observe(editor, {
    childList: true, subtree: true,
    characterData: true, characterDataOldValue: true,
  })
  console.log('[Colophon Content] MutationObserver attached', { target: describeElement(editor) })
}

function onMutation(mutations) {
  if (!_active) return

  // Ignore mutations that originate inside the Gemini sidebar / suggestion panel —
  // typing into the Gemini prompt box and the AI generating its response both
  // produce DOM mutations that look like document edits. We only care about
  // mutations that happen inside the actual document canvas.
  const GEMINI_UI_SELECTORS = [
    '.appsElementsSidekickBarkickTopBox',
    '.appsElementsSidekick',
    '.docos-anchoreddocoview',
    '[id*="colophon"]',
  ]
  const isGeminiUI = (node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false
    return GEMINI_UI_SELECTORS.some(sel => node.closest?.(sel))
  }

  let delta = 0
  for (const m of mutations) {
    const target = m.target
    // Skip mutations whose target is inside any Gemini panel
    if (isGeminiUI(target)) continue

    if (m.type === 'characterData') {
      delta += (m.newValue?.length ?? 0) - (m.oldValue?.length ?? 0)
    } else if (m.type === 'childList') {
      for (const n of m.addedNodes)   { if (!isGeminiUI(n)) delta += n.textContent?.length ?? 0 }
      for (const n of m.removedNodes) { if (!isGeminiUI(n)) delta -= n.textContent?.length ?? 0 }
    }
  }
  if (delta !== 0) {
    console.log('[Colophon Content] mutation delta', { delta, count: mutations.length })
    bufferEdit(delta)
  }
}

// ── Shared buffer + debounce ──────────────────────────────────────────────────

function bufferEdit(delta, isDelete = false) {
  if (Date.now() - _lastPasteAt < PASTE_SUPPRESSION_MS) {
    console.log('[Colophon Content] Edit suppressed after paste', { delta })
    return;
  }
  const nowMs = Date.now()
  if (!_editBuffer) {
    _editBuffer = { timestamp: new Date().toISOString(), delta: 0, velocity: createVelocityTracker() }
    _bufferStartTime = Date.now();
    console.log('[Colophon Content] edit buffer started', { delta })
  }
  _editBuffer.delta += delta
  _editBuffer.velocity.record(isDelete, nowMs)
  console.log('[Colophon Content] edit buffer updated', { delta, total: _editBuffer.delta })
  clearTimeout(_debounce)
  _debounce = setTimeout(flushEdit, DEBOUNCE_MS)
}

function flushEdit() {
  if (!_editBuffer) return
  const v = _editBuffer.velocity.summary()
  const cpm = v.chars_per_min
  const elapsed = Math.max((Date.now() - _bufferStartTime) / 1000, 0.1);
  const absDelta = Math.abs(_editBuffer.delta);
  const insertion_velocity = Math.round(absDelta / elapsed);
  const likely_ai = insertion_velocity > 150 && absDelta > 80;

  console.log('[Colophon Content] edit flush', { delta: _editBuffer.delta, cpm, insertion_velocity, likely_ai })

  const eventType = (likely_ai && _geminiPanelActive) ? 'gemini_suggestion' : 'edit';
  if (eventType === 'gemini_suggestion') _geminiPanelActive = false;

  send('LOG_EVENT', {
    timestamp: _editBuffer.timestamp,
    type: eventType,
    meta: {
      position_start: 0,
      position_end:   Math.max(0, _editBuffer.delta),
      char_delta:     _editBuffer.delta,
      char_count:     absDelta,
      source:         likely_ai ? 'ai' : 'human',
      insertion_velocity,
      likely_ai,
      ...(cpm !== null ? { chars_per_min: cpm, too_fast_for_human: isTooFastForHuman(cpm) } : {}),
      churn_keys: v.churn_keys,
    },
  })
  _editBuffer = null
}

// ── Paste capture ─────────────────────────────────────────────────────────────

const INTERNAL_COPY_TTL = 5 * 60 * 1000; // 5 minutes

function onCopy() {
  if (!isContextValid()) { detachInputListeners(); return; }
  const sel = window.getSelection()?.toString() ?? '';
  if (sel) _lastInternalCopy = { text: sel, at: Date.now() };
}

function onPaste(e) {
  if (!isContextValid()) { detachInputListeners(); return; }
  if (!_active) return;
  if (isTargetingFormInput(e.target)) return;

  const now = Date.now();
  if (now - _lastPasteAt < 100) {
    console.warn('[Colophon Content] Ghost paste detected and destroyed.');
    return;
  }

  _lastPasteAt = now;

  if (e.clipboardData && e.clipboardData.getData('application/x-colophon-ai') === 'true') return;

  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!text) return;

  // If the pasted text matches something the user copied from within this doc, skip logging
  if (_lastInternalCopy &&
      now - _lastInternalCopy.at < INTERNAL_COPY_TTL &&
      text === _lastInternalCopy.text) {
    console.log('[Colophon Content] Internal paste (text move within doc), skipping log.');
    return;
  }

  console.log('[TWFF] Paste intercepted. Running Async Emitter...');
  emitPaste(text);
}

function onInput(e) {
  if (!_active) return
  if (isTargetingFormInput(e.target)) return;
  const inputType = e.inputType ?? ''
  const insertedLength = e.data?.length ?? 0
  console.log('[Colophon Content] input event', {
    inputType,
    dataLength: insertedLength,
    target: describeElement(e.target),
  })

  const { isBlock, origin, chars } = classifyInsertion({ inputType, insertedLength })
  if (isBlock && origin === 'unknown') {
    console.log('[Colophon Content] block insertion (unattributed)', { chars, inputType })
    send('LOG_EVENT', {
      timestamp: new Date().toISOString(),
      type: 'edit',
      meta: {
        position_start: 0,
        position_end:   chars,
        char_delta:     chars,
        source:         'unknown',
        block_insertion: true,
        block_chars:     chars,
      },
    })
  }
}
// function onPaste(e) {
//   if (!_active) return
//   if (e.clipboardData && e.clipboardData.getData('application/x-colophon-ai') === 'true') {
//     return;
//   }
//   const text = e.clipboardData?.getData('text/plain') ?? ''
//   console.log('[Colophon Content] paste event', { charCount: text.length, target: describeElement(e.target) })
//   markPaste(text)
// }

// function onBeforeInput(e) {
//   if (!_active || e.inputType !== 'insertFromPaste') return
//   const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? ''
//   console.log('[Colophon Content] beforeinput paste', { charCount: text.length, target: describeElement(e.target) })
//   markPaste(text)
// }

// function onInput(e) {
//   if (!_active) return
//   console.log('[Colophon Content] input event', {
//     inputType: e.inputType ?? '',
//     dataLength: e.data?.length ?? 0,
//     target: describeElement(e.target),
//   })
// }

// function markPaste(text) {
//   const now = Date.now()
//   if (!_pendingPaste || now - _pendingPaste.startedAt >= PASTE_SUPPRESSION_MS) {
//     _pendingPaste = { startedAt: now, text: '', logged: false }
//   }

//   _lastPasteAt = now
//   if (text.length > _pendingPaste.text.length) {
//     _pendingPaste.text = text
//   }

//   if (_pendingPaste.text && !_pendingPaste.logged) {
//     emitPaste(_pendingPaste.text)
//   }
// }

function _textSimilarity(a, b) {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().match(/\b\w+\b/g) || []);
  const wordsB = new Set(b.toLowerCase().match(/\b\w+\b/g) || []);
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

async function emitPaste(text) {
  const charCount = text.length;
  //if (typeof _pendingPaste !== 'undefined' && _pendingPaste) _pendingPaste.logged = true;

  const event = {
    timestamp: new Date().toISOString(),
    type: 'paste',
    meta: {
      char_count:     charCount,
      source:         'external',
      position_start: 0,
      position_end:   charCount,
      output_preview: formatPreview(text),
      content_before: "",
      content_after:  ""
    },
  };

  const docStateBefore = _rollingBaselineState;

  setTimeout(async () => {
    
    const docStateAfter = await getDocumentText();

    if (docStateAfter) {
      let startIndex = -1;

      // Diff Engine vs. Race Condition Fallback
      if (docStateBefore && docStateBefore.length !== docStateAfter.length) {
        startIndex = findFirstDifference(docStateBefore, docStateAfter);
      } else {
        console.warn("[Colophon Content] Baseline sync missed. Falling back to index search.");
        startIndex = docStateAfter.lastIndexOf(text);
      }

      // Context Extraction
      if (startIndex >= 0) {
        event.meta.content_before = docStateAfter.slice(Math.max(0, startIndex - 300), startIndex).trim();
        const endIndex = startIndex + charCount;
        event.meta.content_after = docStateAfter.slice(endIndex, endIndex + 300).trim();
        event.meta.position_start = startIndex;
        event.meta.position_end = endIndex;
      }
    }

    // Check if this paste matches a pending AI output (e.g. from Paraphrase quick action)
    try {
      const pendingRes = await chrome.runtime.sendMessage({ action: 'GET_PENDING_AI_OUTPUT' });
      if (pendingRes?.text) {
        const similarity = _textSimilarity(text, pendingRes.text);
        if (similarity >= 0.8) {
          event.type = 'ai_interaction';
          event.meta.source = 'paraphrase';
          event.meta.acceptance = 'fully_accepted';
          event.meta.ai_chars = text.length;
          chrome.runtime.sendMessage({ action: 'CLEAR_PENDING_AI_OUTPUT' }).catch(() => {});
          console.log('[Colophon Content] Paste reclassified as AI paraphrase (similarity:', similarity, ')');
        }
      }
    } catch { /* service worker unavailable */ }

    console.log("[Colophon Content] Final Event Ready:", event);
    send('LOG_EVENT', event);

    _rollingBaselineState = docStateAfter;

  }, 1000); 
}

// function emitPaste(text, fallbackCharCount = null) {
//   const charCount = fallbackCharCount ?? text.length
//   if (_pendingPaste) _pendingPaste.logged = true
//   console.log('[Colophon Content] paste emit', {
//     charCount,
//     hasPreview: text.length > 0,
//     fallback: fallbackCharCount !== null,
//   })

//   const event = {
//     timestamp: new Date().toISOString(),
//     type: 'paste',
//     meta: {
//       char_count:     charCount,
//       source:         'external',
//       position_start: 0,
//       position_end:   charCount,
//       output_preview: formatPreview(text),
//     },
//   }

//   if (text.length > 0) {
//     // Wait for the DOM to reflect the paste, then capture surrounding context
//     setTimeout(() => {
//       const doc = _getDocText()
//       const idx = doc.indexOf(text.slice(0, 50))
//       if (idx >= 0) {
//         event.meta.content_before = doc.slice(Math.max(0, idx - 300), idx)
//         event.meta.content_after  = doc.slice(idx + text.length, idx + text.length + 300)
//       }
//       send('LOG_EVENT', event)
//     }, 200)
//   } else {
//     send('LOG_EVENT', event)
//   }
// }

// ── Focus tracking ────────────────────────────────────────────────────────────

function formatPreview(text) {
  return text.length > PREVIEW_LIMIT
    ? text.slice(0, PREVIEW_LIMIT) + '...'
    : text
}

function onVisibilityChange() {
  if (!_active) return
  if (document.hidden) {
    _blurredAt = Date.now()
  } else if (_blurredAt !== null) {
    send('LOG_EVENT', {
      timestamp: new Date().toISOString(),
      type: 'focus_change',
      meta: { duration_ms: Date.now() - _blurredAt },
    })
    _blurredAt = null
  }
}

// ── Messaging ─────────────────────────────────────────────────────────────────

function send(type, payload = {}) {
  console.log('[Colophon Content] send message', { type, payloadType: payload?.type ?? null })
  try {
    chrome.runtime.sendMessage({ type, payload }).catch(() => {
      // SW may be inactive — Chrome will revive it on the next message
    })
  } catch {
    // Extension context invalidated: extension was reloaded mid-session.
    // Silently drop the message — refreshing the tab will restore the connection.
  }
}

// ── Export Fetcher (Bypasses Auth Blocks) ─────────────────────────────────────

async function forceFetchExport(docId, format) {
  const url = `https://docs.google.com/document/d/${docId}/export?format=${format}`;
  const res = await fetch(url);
  
  if (!res.ok) {
      throw new Error(`Google blocked Content Script fetch: ${res.status}`);
  }

  const blob = await res.blob();
  return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
          const base64data = reader.result.split(',')[1]; 
          resolve({ base64: base64data });
      };
      reader.readAsDataURL(blob);
  });
}

// ── Floating in-page panel ────────────────────────────────────────────────────

function toggleFloatingPanel() {
  if (_floatingPanel) {
    destroyFloatingPanel()
    return
  }
  createFloatingPanel()
}

function createFloatingPanel() {
  const host = document.createElement('div')
  host.id = 'colophon-floating-panel'
  host.style.position = 'fixed'
  host.style.top = '72px'
  host.style.right = '24px'
  host.style.zIndex = '2147483647'
  host.style.width = 'min(360px, calc(100vw - 28px))'
  host.style.height = 'min(720px, calc(100vh - 28px))'

  const shadow = host.attachShadow({ mode: 'open' })
  const shell = document.createElement('div')
  shell.className = 'floating-shell'
  shell.style.position = 'static'
  shadow.append(shell)

  document.documentElement.append(host)

  const panel = mountColophonPanel(shell, {
    mode: 'floating',
    docTitle: getDocsTitle(),
    onClose: destroyFloatingPanel,
    onPin: toggleFloatingPin,
  })

  _floatingPanel = { host, shadow, panel }
  attachFloatingDrag()
}

function destroyFloatingPanel() {
  if (!_floatingPanel) return
  _floatingPanel.panel.destroy()
  _floatingPanel.host.remove()
  _floatingPanel = null
  _floatingPinned = false
}

function toggleFloatingPin() {
  if (!_floatingPanel) return
  _floatingPinned = !_floatingPinned
  _floatingPanel.host.style.boxShadow = _floatingPinned
    ? '0 0 0 2px rgba(93, 63, 211, 0.28)'
    : ''
  _floatingPanel.host.dataset.pinned = String(_floatingPinned)
}

function attachFloatingDrag() {
  const panel = _floatingPanel
  if (!panel) return

  let drag = null

  panel.shadow.addEventListener('pointerdown', event => {
    if (_floatingPinned) return
    const handle = event.target.closest?.('[data-role="drag-handle"]')
    if (!handle) return

    const rect = panel.host.getBoundingClientRect()
    panel.host.style.left = `${rect.left}px`
    panel.host.style.top = `${rect.top}px`
    panel.host.style.right = 'auto'

    drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
    handle.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  })

  panel.shadow.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return

    const width = panel.host.offsetWidth
    const height = panel.host.offsetHeight
    const nextLeft = Math.min(Math.max(8, event.clientX - drag.offsetX), window.innerWidth - width - 8)
    const nextTop = Math.min(Math.max(8, event.clientY - drag.offsetY), window.innerHeight - height - 8)

    panel.host.style.left = `${nextLeft}px`
    panel.host.style.top = `${nextTop}px`
  })

  panel.shadow.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return
    drag = null
  })
}

// ── Get Live Title ───────────────────────────────────────────────────

function getDocsTitle() {
  const titleInput = document.querySelector('.docs-title-input');
  if (titleInput && titleInput.value && titleInput.value.trim() !== "") {
    return titleInput.value;
  }

  const titleInner = document.querySelector('.docs-title-inner');
  if (titleInner && titleInner.innerText && titleInner.innerText.trim() !== "") {
     return titleInner.innerText;
  }

  const branding = document.querySelector('.docs-branding');
  if (branding) {
    const nearbyInput = branding.parentElement.querySelector('input[type="text"]');
    if (nearbyInput && nearbyInput.value && nearbyInput.value.trim() !== "") {
      return nearbyInput.value;
    }
  }

  const fallbackTitle = document.title.replace(' - Google Docs', '').trim();

  if (!fallbackTitle || fallbackTitle === "Untitled document" || fallbackTitle === "Google Docs") {
    return "Untitled Document";
  }

  return fallbackTitle;
}

// ── Find & click native Gemini action buttons ─────────────────────────────
/**
 * Searches the Gemini popover/sidebar for a button matching the given
 * action type ('accept' | 'reject') and returns the first match.
 *
 * Uses the same classifyAction() logic as the detector so both paths stay
 * in sync when Google reshuffles class names.
 */
function findGeminiActionButton(actionType) {
  const { classifyAction: classify } = /** @type {any} */ (window.__colophon_geminiSelectors || {});

  // Containers where the Gemini accept/reject buttons live.
  const CONTAINERS = [
    '.appsElementsSidekickBarkickTopBox',
    '.docos-anchoreddocoview',
    '.docosAiPreviewDiffVisibleSuggestionViewContent',
    '[role="dialog"]',
    '[aria-label*="Gemini" i]',
    '[aria-label*="Help me write" i]',
  ];

  for (const sel of CONTAINERS) {
    const containers = Array.from(document.querySelectorAll(sel));
    for (const container of containers) {
      const buttons = Array.from(container.querySelectorAll('button, [role="button"]'));
      for (const btn of buttons) {
        // Use classifyAction from gemini-selectors via the shared import.
        // We inline a lightweight version here so content.js stays self-contained.
        const label = (btn.getAttribute?.('aria-label') ?? btn.textContent ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
        const dataAction = btn.getAttribute?.('data-action-type');

        const isAccept = (
          dataAction === '44' ||
          btn.classList?.contains('appsElementsSidekickResponseOptionsActionBarButtonPrimary') ||
          btn.classList?.contains('docosAiPreviewDiffVisibleSuggestionViewAcceptButton') ||
          ['insert', 'replace', 'accept', 'accept all', 'accept suggestion'].includes(label) ||
          label.startsWith('accept') || label.startsWith('insert') || label.startsWith('replace')
        );
        const isReject = (
          dataAction === '45' ||
          btn.classList?.contains('appsElementsSidekickResponseOptionsActionBarButtonSecondary') ||
          btn.classList?.contains('docosAiPreviewDiffVisibleSuggestionViewRejectButton') ||
          ['close', 'cancel', 'discard', 'reject', 'reject all'].includes(label) ||
          label.startsWith('reject') || label.startsWith('discard') || label.startsWith('close')
        );

        if (actionType === 'accept' && isAccept) return btn;
        if (actionType === 'reject' && isReject) return btn;
      }
    }
  }
  return null;
}

// ── Insert AI Text into Docs Canvas ──────────────────────────────────
async function insertTextIntoDocs(textToInsert) {
  try {
    let targetElement = null;
    let targetFrame = null;

    const frames = [
      ...document.querySelectorAll('.docs-texteventtarget-iframe'),
      ...document.querySelectorAll('iframe[aria-hidden="true"]'),
    ];

    for (const frame of frames) {
      const doc = frame.contentDocument || frame.contentWindow?.document;
      if (doc) {
        targetElement = doc.body;
        targetFrame = frame;
        break;
      }
    }

    if (!targetElement) {
      throw new Error("Could not find Google Docs input element to paste into.");
    }

    targetFrame.contentWindow.focus();
    targetElement.focus();

    // 50 ms for the browser to settle focus before dispatching the paste event.
    await new Promise(resolve => setTimeout(resolve, 50));

    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', textToInsert);
    dataTransfer.setData('application/x-colophon-ai', 'true');

    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true
    });

    targetElement.dispatchEvent(pasteEvent);

    console.log("[Colophon Content] Auto-paste executed successfully.");
    return true;

  } catch (error) {
    console.error("[Colophon Content] Insertion Error:", error);
    throw error;
  }
}

// ── IN-PAGE TOAST NOTIFICATION ─────────────────────────────────

async function checkAndInjectStartToast() {
  console.log("[Colophon] Checking if start toast is needed...");

  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  } catch {
    console.warn("[Colophon] Service worker unavailable, skipping toast.");
    return;
  }
  const isRecording = state?.session?.isRecording;
  
  if (isRecording) {
    console.log("[Colophon] Session already active. Skipping toast.");
    return; 
  }

  if (document.getElementById('colophon-inpage-toast')) return;

  console.log("[Colophon] Injecting Trusted-Type safe toast into Google Docs!");

  const toast = document.createElement('div');
  toast.id = 'colophon-inpage-toast';

  toast.style.cssText = `
    position: fixed;
    top: 24px; 
    right: 24px;
    background: #202124;
    color: #fff;
    padding: 16px 20px;
    border-radius: 8px;
    font-family: 'Google Sans', Arial, sans-serif;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 16px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.2);
    z-index: 2147483647;
    opacity: 0;
    transform: translateY(-20px); 
    transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  `;

  const infoWrapper = document.createElement('div');
  infoWrapper.style.display = 'flex';
  infoWrapper.style.alignItems = 'center';
  infoWrapper.style.gap = '8px';

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", "20"); svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "#0288d1"); svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");

  const circle = document.createElementNS(svgNS, "circle");
  circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12"); circle.setAttribute("r", "10");

  const line1 = document.createElementNS(svgNS, "line");
  line1.setAttribute("x1", "12"); line1.setAttribute("y1", "16"); line1.setAttribute("x2", "12"); line1.setAttribute("y2", "12");

  const line2 = document.createElementNS(svgNS, "line");
  line2.setAttribute("x1", "12"); line2.setAttribute("y1", "8"); line2.setAttribute("x2", "12.01"); line2.setAttribute("y2", "8");

  svg.append(circle, line1, line2);

  const textNode = document.createElement('span');
  textNode.textContent = "Colophon is inactive. Start recording before you edit!";

  infoWrapper.append(svg, textNode);

  const startBtn = document.createElement('button');
  startBtn.id = 'colophon-quick-start';
  startBtn.textContent = 'Start Session';
  startBtn.style.cssText = `
    background: #0288d1;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    font-weight: bold;
    cursor: pointer;
    transition: background 0.2s;
  `;

  const dismissBtn = document.createElement('button');
  dismissBtn.setAttribute('aria-label', 'Dismiss');
  dismissBtn.textContent = '✕';
  dismissBtn.style.cssText = `
    background: none;
    border: none;
    color: rgba(255,255,255,0.6);
    font-size: 16px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  `;

  toast.append(infoWrapper, startBtn, dismissBtn);
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  }, 100);

  const removeToast = () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-20px)';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 400); 
  };

  const timeoutId = setTimeout(removeToast, 30000);

  dismissBtn.addEventListener('click', () => { clearTimeout(timeoutId); removeToast(); });
  dismissBtn.addEventListener('mouseenter', () => dismissBtn.style.color = 'white');
  dismissBtn.addEventListener('mouseleave', () => dismissBtn.style.color = 'rgba(255,255,255,0.6)');

  startBtn.addEventListener('mouseenter', () => startBtn.style.background = '#0277bd');
  startBtn.addEventListener('mouseleave', () => startBtn.style.background = '#0288d1');

  startBtn.addEventListener('click', async () => {
    clearTimeout(timeoutId);

    startBtn.textContent = 'Starting...';
    startBtn.style.background = '#28a745'; 
    startBtn.style.cursor = 'default';

    const currentUrl = window.location.href;

    try {
      await chrome.runtime.sendMessage({ type: 'SESSION_START', docUrl: currentUrl });
    } catch {
      removeToast();
      return;
    }

    toast.replaceChildren();

    const successSpan = document.createElement('span');
    successSpan.style.color = '#28a745';
    successSpan.style.fontWeight = 'bold';
    successSpan.textContent = 'Session Started!';

    toast.appendChild(successSpan);
    setTimeout(removeToast, 2000);
  });
}

// ── Gemini "Help me write" Detection ─────────────────────────────────────────

function initGeminiObserver() {
  if (_geminiObserver) return;
  _geminiObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = /** @type {Element} */ (node);
        // Gemini sidebar and "Help me write" panel use these markers
        if (
          el.matches?.('.docs-material-surface, [data-feature-id], [jsname="QkNstf"]') ||
          el.querySelector?.('.docs-material-surface, [data-feature-id="smart-compose"]')
        ) {
          console.log('[Colophon Content] Gemini panel detected');
          _geminiPanelActive = true;
          // Auto-reset after 2 minutes to avoid false positives
          setTimeout(() => { _geminiPanelActive = false; }, 120000);
        }
      }
    }
  });
  _geminiObserver.observe(document.body, { childList: true, subtree: true });
}

// ── BOOT UP FOR TOAST NOTIFICATION──
function initColophonUI() {
  setTimeout(checkAndInjectStartToast, 2000);
  initGeminiObserver();
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initColophonUI();
} else {
  window.addEventListener('load', initColophonUI);
}

/**
 * ── EXPORT GRABBER ──
 * Silently downloads the current document state into RAM as a .txt file.
 */
async function getDocumentText() {
  const match = window.location.pathname.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) return "";
  const docId = match[1];

  try {
    // cache: 'no-store' prevents the browser from returning a cached response.
    // The timestamp query param additionally busts Google's CDN cache so we
    // always receive the current server-side document state.
    const response = await fetch(
      `https://docs.google.com/document/d/${docId}/export?format=txt&t=${Date.now()}`,
      { cache: 'no-store' }
    );
    if (!response.ok) throw new Error(`Status: ${response.status}`);
    
    const text = await response.text();
    return text.replace(/^\uFEFF/, '');
  } catch (err) {
    console.error("[Colophon Content] Failed to download document state:", err);
    return "";
  }
}

/**
 * Resolves to a resolved(sic) utility.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls getDocumentText() every `intervalMs` until the returned text differs
 * from `baseline`, or until `maxWaitMs` has elapsed. Returns the new text if
 * a change was detected, or null on timeout.
 *
 * This handles the 5–15 s lag between a Google Docs autosave and the export
 * endpoint reflecting the change, which caused the old 800 ms single-fetch
 * to always return stale (pre-change) content.
 */
async function pollForDocChange(baseline, maxWaitMs = 20000, intervalMs = 2000) {
  if (!baseline) {
    // No baseline to compare against — just wait and return whatever we get.
    await sleep(intervalMs);
    return await getDocumentText() || null;
  }

  const deadline = Date.now() + maxWaitMs;
  console.log('[Colophon Content] pollForDocChange started', { baselineChars: baseline.length, maxWaitMs });

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    try {
      const newText = await getDocumentText();
      if (newText && newText !== baseline) {
        console.log('[Colophon Content] pollForDocChange: change detected', { newChars: newText.length });
        return newText;
      }
      console.log('[Colophon Content] pollForDocChange: no change yet, retrying...');
    } catch {
      // transient fetch error — keep polling
    }
  }

  console.warn('[Colophon Content] pollForDocChange: timed out — export API did not reflect change within', maxWaitMs, 'ms');
  return null;
}

/**
 * Compares two document states character-by-character.
 * Returns the exact index where the new text was inserted.
 */
function findFirstDifference(oldText, newText) {
  if (!oldText || !newText) return -1;
  
  let i = 0;

  while (i < oldText.length && i < newText.length && oldText[i] === newText[i]) {
    i++;
  }
  return i; 
}

function computeDocumentDiff(oldText, newText) {
  if (!oldText || !newText) return { addedText: '', removedText: '' };
  if (oldText === newText) return { addedText: '', removedText: '' };

  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) {
    start++;
  }

  let oldEnd = oldText.length - 1;
  let newEnd = newText.length - 1;
  while (oldEnd >= start && newEnd >= start && oldText[oldEnd] === newText[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const removedText = oldText.slice(start, oldEnd + 1).trim();
  const addedText = newText.slice(start, newEnd + 1).trim();

  return { addedText, removedText };
}

async function updateRollingBaseline(forceSendResponse = null) {
  if (_isFetchingBaseline) {
    if (forceSendResponse) forceSendResponse({ ok: false, reason: 'already_fetching' });
    return;
  }

  _isFetchingBaseline = true;
  try {
    const text = await getDocumentText();
    if (text) {
      _rollingBaselineState = text;
      _lastSnapshotTime = Date.now();

      // Push clean export-API text so the AI always has fresh document context,
      // even when DOM scraping (GET_EDITOR_TEXT) fails due to extension reloads.
      chrome.runtime.sendMessage({
        action: 'UPDATE_DOC_CONTEXT',
        payload: { text, cursorIndex: text.length, selectedText: '', lastSnapshotTime: _lastSnapshotTime },
      }).catch(() => {});

      // Keep pre_session_snapshot current (not frozen at recording start)
      chrome.runtime.sendMessage({
        action: 'SET_PRE_SESSION_TEXT',
        payload: { text: text.slice(0, 20000), timestamp: _lastSnapshotTime },
      }).catch(() => {});

      if (forceSendResponse) forceSendResponse({ ok: true, timestamp: _lastSnapshotTime });
    } else {
      if (forceSendResponse) forceSendResponse({ ok: false, reason: 'no_text' });
    }
  } catch (err) {
    console.error("[Colophon Content] Baseline fetch failed:", err);
    if (forceSendResponse) forceSendResponse({ ok: false, reason: err.message });
  } finally {
    _isFetchingBaseline = false; // Unlock
  }
}

document.addEventListener('keydown', (e) => {
  if (!isContextValid()) return;
  // Ignore Ctrl+V so we don't trigger a snapshot mid-paste
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;

  clearTimeout(_baselineTimer);
  
  let delayMs = 1500; 
  const docSizeKb = _rollingBaselineState.length / 1024;
  
  if (docSizeKb >= 50 && docSizeKb < 300) delayMs = 3000;
  else if (docSizeKb >= 300) delayMs = 5000;

  _baselineTimer = setTimeout(updateRollingBaseline, delayMs); 
});