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
  if (msg.type === '__PING__')   sendResponse({ ok: true, active: _active })
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

async function syncRecordingState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
    console.log('[Colophon Content] sync recording state', {
      hasSession: !!state?.session,
      isRecording: !!state?.session?.isRecording,
    })
    if (state?.session?.isRecording) activate()
  } catch {
    // Popup activation remains the main path if the service worker is waking.
  }
}

function deactivate() {
  if (!_active) return
  _active = false
  detachInputListeners()
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
  const delta = (e.key === 'Backspace' || e.key === 'Delete') ? -1 : 1
  console.log('[Colophon Content] keydown captured', { code: e.code, delta, target: describeElement(e.target) })
  bufferEdit(delta)
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

function bufferEdit(delta) {
  if (Date.now() - _lastPasteAt < PASTE_SUPPRESSION_MS) {
    console.log('[Colophon Content] edit suppressed after paste', { delta })
    if (_pendingPaste && !_pendingPaste.logged && delta > 0) {
      emitPaste('', delta)
    }
    return
  }
  if (!_editBuffer) {
    _editBuffer = { timestamp: new Date().toISOString(), delta: 0 }
    console.log('[Colophon Content] edit buffer started', { delta })
  }
  _editBuffer.delta += delta
  console.log('[Colophon Content] edit buffer updated', { delta, total: _editBuffer.delta })
  clearTimeout(_debounce)
  _debounce = setTimeout(flushEdit, DEBOUNCE_MS)
}

function flushEdit() {
  if (!_editBuffer) return
  console.log('[Colophon Content] edit flush', { delta: _editBuffer.delta })
  send('LOG_EVENT', {
    timestamp: _editBuffer.timestamp,
    type: 'edit',
    meta: {
      position_start: 0,                          // Sprint 2: real cursor position
      position_end:   Math.max(0, _editBuffer.delta),
      char_delta:     _editBuffer.delta,
      source:         'human',
    },
  })
  _editBuffer = null
}

// ── Paste capture ─────────────────────────────────────────────────────────────

function onPaste(e) {
  if (!_active) return
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
  console.log('[Colophon Content] input event', {
    inputType: e.inputType ?? '',
    dataLength: e.data?.length ?? 0,
    target: describeElement(e.target),
  })
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
  chrome.runtime.sendMessage({ type, payload }).catch(() => {
    // SW may be inactive — Chrome will revive it on the next message
  })
}
