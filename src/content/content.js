import { mountColophonPanel } from '../panel/app.js'
import { createGeminiDetector } from './gemini-detector.js'
import { createVelocityTracker, isTooFastForHuman } from './edit-velocity.js'
import { classifyInsertion } from './block-insertion.js'

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
let _floatingPanel = null
let _floatingPinned = false

// Native Google Docs Gemini ("Help me write" / "Refine") suggestion detector.
// Emits ai_suggestion / ai_interaction events via the same send() path as edits.
const _geminiDetector = createGeminiDetector({
  emit: event => send('LOG_EVENT', event),
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  // When a Gemini suggestion is accepted, Docs inserts the text. Mark the paste
  // suppression window so the resulting edit/paste isn't double-logged as a
  // human edit — the ai_interaction event already records that insertion.
  onResolve: ({ accepted }) => {
    if (accepted) {
      _lastPasteAt = Date.now()
      _pendingPaste = { startedAt: Date.now(), text: '', logged: true }
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
  if (msg.type === 'ACTIVATE')   { console.log('[Colophon Content] ACTIVATE message'); activate() }
  if (msg.type === 'DEACTIVATE') { console.log('[Colophon Content] DEACTIVATE message'); deactivate() }
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
})

syncRecordingState()

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
  console.log('[Colophon Content] recording activated', {
    activeElement: describeElement(document.activeElement),
    hasEditor: !!document.querySelector(EDITOR_SELECTOR),
  })
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
  target.addEventListener('beforeinput', onBeforeInput, true)
  target.addEventListener('input', onInput, true)
  _listenerTargets.push({ target, label })
  console.log('[Colophon Content] input listeners attached', { label })
}

function detachInputListeners() {
  for (const { target, label } of _listenerTargets) {
    target.removeEventListener('keydown', onKeydown, true)
    target.removeEventListener('paste', onPaste, true)
    target.removeEventListener('beforeinput', onBeforeInput, true)
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
      console.log('[Colophon Content] text iframe reachable', {
        frame: describeElement(frame),
        readyState: doc.readyState,
        activeElement: describeElement(doc.activeElement),
      })
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
  _observer?.disconnect()
  _observer = null
  clearTimeout(_debounce)
  flushEdit() // flush anything buffered before stopping
  _editBuffer = null
  console.log('[Colophon Content] recording deactivated')
}

// ── Edit capture: keydown (primary) ──────────────────────────────────────────

function onKeydown(e) {
  if (!_active) return
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
  let delta = 0
  for (const m of mutations) {
    if (m.type === 'characterData') {
      delta += (m.newValue?.length ?? 0) - (m.oldValue?.length ?? 0)
    } else if (m.type === 'childList') {
      for (const n of m.addedNodes)   delta += n.textContent?.length ?? 0
      for (const n of m.removedNodes) delta -= n.textContent?.length ?? 0
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
    console.log('[Colophon Content] edit suppressed after paste', { delta })
    if (_pendingPaste && !_pendingPaste.logged && delta > 0) {
      emitPaste('', delta)
    }
    return
  }
  const nowMs = Date.now()
  if (!_editBuffer) {
    // The velocity tracker only sees keystrokes that pass the paste guard above,
    // so velocity never mixes typing with pasting. It handles pauses (idle gaps)
    // and churn (backspace/delete) internally — see edit-velocity.js.
    _editBuffer = { timestamp: new Date().toISOString(), delta: 0, velocity: createVelocityTracker() }
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
  console.log('[Colophon Content] edit flush', { delta: _editBuffer.delta, cpm, churn: v.churn_keys })
  send('LOG_EVENT', {
    timestamp: _editBuffer.timestamp,
    type: 'edit',
    meta: {
      position_start: 0,                          // Sprint 2: real cursor position
      position_end:   Math.max(0, _editBuffer.delta),
      char_delta:     _editBuffer.delta,
      source:         'human',
      // Edit velocity (chars/min) over active typing time (pauses excluded),
      // with a flag when it exceeds plausible human speed — a signal for
      // AI-pasted-then-disguised text. churn_keys = backspace/delete count.
      // null cpm = burst too short to measure.
      ...(cpm !== null ? { chars_per_min: cpm, too_fast_for_human: isTooFastForHuman(cpm) } : {}),
      churn_keys: v.churn_keys,
    },
  })
  _editBuffer = null
}

// ── Paste capture ─────────────────────────────────────────────────────────────

function onPaste(e) {
  if (!_active) return
  if (e.clipboardData && e.clipboardData.getData('application/x-colophon-ai') === 'true') {
    return;
  }
  const text = e.clipboardData?.getData('text/plain') ?? ''
  console.log('[Colophon Content] paste event', { charCount: text.length, target: describeElement(e.target) })
  markPaste(text)
}

function onBeforeInput(e) {
  if (!_active || e.inputType !== 'insertFromPaste') return
  const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? ''
  console.log('[Colophon Content] beforeinput paste', { charCount: text.length, target: describeElement(e.target) })
  markPaste(text)
}

function onInput(e) {
  if (!_active) return
  const inputType = e.inputType ?? ''
  const insertedLength = e.data?.length ?? 0
  console.log('[Colophon Content] input event', {
    inputType,
    dataLength: insertedLength,
    target: describeElement(e.target),
  })

  // Block-insertion detection: a large chunk arriving in one input frame wasn't
  // typed. Classify paste vs AI vs unknown ("humanised"/injected text). Paste
  // and AI already have dedicated events; we emit a block_insertion signal only
  // for the UNKNOWN case so we don't double-log what onPaste / the Gemini
  // detector already cover.
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
        source:         'unknown',       // not typed, not a known paste/AI insert
        block_insertion: true,
        block_chars:     chars,
      },
    })
  }
}

function markPaste(text) {
  const now = Date.now()
  if (!_pendingPaste || now - _pendingPaste.startedAt >= PASTE_SUPPRESSION_MS) {
    _pendingPaste = { startedAt: now, text: '', logged: false }
  }

  _lastPasteAt = now
  if (text.length > _pendingPaste.text.length) {
    _pendingPaste.text = text
  }

  if (_pendingPaste.text && !_pendingPaste.logged) {
    emitPaste(_pendingPaste.text)
  }
}

function emitPaste(text, fallbackCharCount = null) {
  const charCount = fallbackCharCount ?? text.length
  if (_pendingPaste) _pendingPaste.logged = true
  console.log('[Colophon Content] paste emit', {
    charCount,
    hasPreview: text.length > 0,
    fallback: fallbackCharCount !== null,
  })
  send('LOG_EVENT', {
    timestamp: new Date().toISOString(),
    type: 'paste',
    meta: {
      char_count:     charCount,
      source:         'external',
      position_start: 0,
      position_end:   charCount,
      output_preview: formatPreview(text),
    },
  })
}

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

// ── Insert AI Text into Docs Canvas ──────────────────────────────────
async function insertTextIntoDocs(textToInsert) {
  try {
    let targetElement = null;

    const frames = [
      ...document.querySelectorAll('.docs-texteventtarget-iframe'),
      ...document.querySelectorAll('iframe[aria-hidden="true"]'),
    ];

    for (const frame of frames) {
      const doc = frame.contentDocument || frame.contentWindow?.document;
      if (doc) {
        targetElement = doc.activeElement || doc.body;
        break;
      }
    }

    if (!targetElement) {
      throw new Error("Could not find Google Docs input element to paste into.");
    }

    targetElement.focus();

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
