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
const EDITOR_POLL_MS  = 800

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

// ── Bootstrap ─────────────────────────────────────────────────────────────────

console.log('[Colophon] Content script injected on', location.pathname)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ACTIVATE')   activate()
  if (msg.type === 'DEACTIVATE') deactivate()
  if (msg.type === '__PING__')   sendResponse({ ok: true, active: _active })
})

// ── Activation ────────────────────────────────────────────────────────────────

function activate() {
  if (_active) return
  _active = true
  // Primary: keydown (works in canvas renderer)
  document.addEventListener('keydown', onKeydown)
  // Secondary: MutationObserver (works in legacy/non-canvas renderer)
  waitForEditor(attachObserver)
  document.addEventListener('paste', onPaste, true)
  document.addEventListener('visibilitychange', onVisibilityChange)
  console.log('[Colophon] Recording activated.')
}

function deactivate() {
  if (!_active) return
  _active = false
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('paste', onPaste, true)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  _observer?.disconnect()
  _observer = null
  clearTimeout(_debounce)
  flushEdit() // flush anything buffered before stopping
  _editBuffer = null
  console.log('[Colophon] Recording deactivated.')
}

// ── Edit capture: keydown (primary) ──────────────────────────────────────────

function onKeydown(e) {
  if (!_active) return
  if (SKIP_KEYS.has(e.key)) return
  if (e.ctrlKey || e.metaKey) return // skip shortcuts (Ctrl+C, Cmd+Z, etc.)

  // Backspace/Delete remove a character; everything else adds one
  const delta = (e.key === 'Backspace' || e.key === 'Delete') ? -1 : 1
  bufferEdit(delta)
}

// ── Edit capture: MutationObserver (secondary) ────────────────────────────────

function waitForEditor(callback) {
  const el = document.querySelector(EDITOR_SELECTOR)
  if (el) { callback(el); return }
  setTimeout(() => waitForEditor(callback), EDITOR_POLL_MS)
}

function attachObserver(editor) {
  _observer = new MutationObserver(onMutation)
  _observer.observe(editor, {
    childList: true, subtree: true,
    characterData: true, characterDataOldValue: true,
  })
  console.log('[Colophon] MutationObserver attached (secondary).')
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
  if (delta !== 0) bufferEdit(delta)
}

// ── Shared buffer + debounce ──────────────────────────────────────────────────

function bufferEdit(delta) {
  if (!_editBuffer) {
    _editBuffer = { timestamp: new Date().toISOString(), delta: 0 }
  }
  _editBuffer.delta += delta
  clearTimeout(_debounce)
  _debounce = setTimeout(flushEdit, DEBOUNCE_MS)
}

function flushEdit() {
  if (!_editBuffer) return
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
  send('LOG_EVENT', {
    timestamp: new Date().toISOString(),
    type: 'paste',
    meta: {
      char_count:     text.length,
      source:         'external',
      position_start: 0,
      position_end:   text.length,
    },
  })
}

// ── Focus tracking ────────────────────────────────────────────────────────────

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
  chrome.runtime.sendMessage({ type, payload }).catch(() => {
    // SW may be inactive — Chrome will revive it on the next message
  })
}
