import { mountColophonPanel } from '../panel/app.js'

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
let _checkpointTimer = null
let _selectionDebounce = null
let _rollingBaselineState = "";
let _baselineTimer = null;
let _isFetchingBaseline = false;

function _getDocText() {
  return Array.from(document.querySelectorAll('.kix-paragraphrenderer'))
    .map(p => p.textContent).join('\n').slice(0, 20000)
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
  document.addEventListener('visibilitychange', onVisibilityChange)
  // Periodic checkpoints every 5 minutes
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
  }, 5 * 60 * 1000)
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
  //target.addEventListener('beforeinput', onBeforeInput, true)
  //target.addEventListener('input', onInput, true)
  _listenerTargets.push({ target, label })
  console.log('[Colophon Content] input listeners attached', { label })
}

function detachInputListeners() {
  for (const { target, label } of _listenerTargets) {
    target.removeEventListener('keydown', onKeydown, true)
    target.removeEventListener('paste', onPaste, true)
    //target.removeEventListener('beforeinput', onBeforeInput, true)
    //target.removeEventListener('input', onInput, true)
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
    console.log('[Colophon Content] Edit suppressed after paste', { delta })
    return;
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
  if (!_active) return;
  
  const now = Date.now();
  if (now - _lastPasteAt < 100) {
    console.warn('[Colophon Content] Ghost paste detected and destroyed.');
    return; 
  }
  
  _lastPasteAt = now;

  if (e.clipboardData && e.clipboardData.getData('application/x-colophon-ai') === 'true') return;
  
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!text) return;

  console.log('[TWFF] Paste intercepted. Running Async Emitter...');
  emitPaste(text);
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
  chrome.runtime.sendMessage({ type, payload }).catch(() => {
    // SW may be inactive — Chrome will revive it on the next message
  })
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

// ── IN-PAGE TOAST NOTIFICATION ─────────────────────────────────

async function checkAndInjectStartToast() {
  console.log("[Colophon] Checking if start toast is needed...");

  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
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

  toast.append(infoWrapper, startBtn);
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

  startBtn.addEventListener('mouseenter', () => startBtn.style.background = '#0277bd');
  startBtn.addEventListener('mouseleave', () => startBtn.style.background = '#0288d1');

  startBtn.addEventListener('click', async () => {
    clearTimeout(timeoutId);

    startBtn.textContent = 'Starting...';
    startBtn.style.background = '#28a745'; 
    startBtn.style.cursor = 'default';

    const currentUrl = window.location.href;

    await chrome.runtime.sendMessage({ type: 'SESSION_START', docUrl: currentUrl }, () => {

      toast.replaceChildren();
      
      const successSpan = document.createElement('span');
      successSpan.style.color = '#28a745';
      successSpan.style.fontWeight = 'bold';
      successSpan.textContent = 'Session Started!';
      
      toast.appendChild(successSpan);
      setTimeout(removeToast, 2000);
    });
  });
}

// ── BOOT UP FOR TOAST NOTIFICATION──
function initColophonUI() {
  setTimeout(checkAndInjectStartToast, 2000); 
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
    const response = await fetch(`https://docs.google.com/document/d/${docId}/export?format=txt`);
    if (!response.ok) throw new Error(`Status: ${response.status}`);
    
    let text = await response.text();
    return text.replace(/^\uFEFF/, '');
  } catch (err) {
    console.error("[Colophon Content] Failed to download document state:", err);
    return "";
  }
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

async function updateRollingBaseline() {
  if (_isFetchingBaseline) return; // Mutex Lock: Abort if already downloading
  
  _isFetchingBaseline = true; 
  try {
    const text = await getDocumentText();
    if (text) _rollingBaselineState = text;
  } catch (err) {
    console.error("[Colophon Content] Baseline fetch failed:", err);
  } finally {
    _isFetchingBaseline = false; // Unlock
  }
}

document.addEventListener('keydown', (e) => {
  // Ignore Ctrl+V so we don't trigger a snapshot mid-paste
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;

  clearTimeout(_baselineTimer);
  
  let delayMs = 1500; 
  const docSizeKb = _rollingBaselineState.length / 1024;
  
  if (docSizeKb >= 50 && docSizeKb < 300) delayMs = 3000;
  else if (docSizeKb >= 300) delayMs = 5000;

  _baselineTimer = setTimeout(updateRollingBaseline, delayMs); 
});