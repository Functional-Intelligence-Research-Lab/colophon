/**
 * service-worker.js — Colophon background service worker (MV3)
 *
 * Owns session state. Content script and popup talk through here.
 *
 * Message protocol:
 *   Popup  → SW:    SESSION_START { tabId, docUrl }
 *   Popup  → SW:    SESSION_STOP
 *   Popup  → SW:    GET_STATE
 *   Popup  → SW:    EXPORT
 *   Content → SW:   LOG_EVENT { TwffEvent }
 *
 * SW → content:  ACTIVATE / DEACTIVATE (via chrome.tabs.sendMessage)
 */

import { getSession, saveSession, clearSession, ensureUserId } from '../shared/storage.js'
import { buildProcessLog } from '../shared/process-log.js'

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Colophon] Installed.')
})

// ── Message routing ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => {
      console.error('[Colophon]', err.message)
      sendResponse({ error: err.message })
    })
  return true // keep port open for async response
})

async function handleMessage(msg, _sender) {
  switch (msg.type) {
    case 'SESSION_START': return startSession(msg.payload)
    case 'SESSION_STOP':  return stopSession()
    case 'LOG_EVENT':     return appendEvent(msg.payload)
    case 'GET_STATE':     return getState()
    case 'EXPORT':        return exportSession()
    default:
      throw new Error(`Unknown message type: ${msg.type}`)
  }
}

// ── Session management ────────────────────────────────────────────────────────

async function startSession({ tabId, docUrl } = {}) {
  await clearSession()

  const docId = docUrl ? await hashDocUrl(docUrl) : ''
  const now   = new Date().toISOString()

  const session = {
    sessionId:   crypto.randomUUID(),
    startedAt:   now,
    tabId:       tabId ?? null,
    docId,
    isRecording: true,
    events:      [],
  }
  session.events.push({ timestamp: now, type: 'session_start', meta: {} })
  await saveSession(session)

  // Tell content script to activate its observers
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE' }).catch(() => {
      // Content script not ready — it will check isRecording on next inject
    })
  }

  return { ok: true, sessionId: session.sessionId }
}

async function stopSession() {
  const session = await getSession()
  if (!session) return { ok: false, reason: 'no session' }

  session.isRecording = false
  session.events.push({ timestamp: new Date().toISOString(), type: 'session_end', meta: {} })
  await saveSession(session)

  if (session.tabId) {
    chrome.tabs.sendMessage(session.tabId, { type: 'DEACTIVATE' }).catch(() => {})
  }

  return { ok: true }
}

async function appendEvent(event) {
  const session = await getSession()
  if (!session?.isRecording) return { ok: false }
  session.events.push(event)
  await saveSession(session)
  return { ok: true }
}

async function getState() {
  const session = await getSession()
  if (!session) return { session: null, stats: null }

  const editCount = session.events.filter(e => e.type === 'edit').length
  const aiCount   = session.events.filter(e => e.type === 'ai_interaction').length
  const elapsed   = session.isRecording
    ? Date.now() - new Date(session.startedAt).getTime()
    : 0

  return { session, stats: { editCount, aiCount, elapsed } }
}

async function exportSession() {
  const session = await getSession()
  if (!session) throw new Error('No session to export.')
  const userId = await ensureUserId()
  const log    = await buildProcessLog(session, userId)
  return { log }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function hashDocUrl(url) {
  const path = new URL(url).pathname
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path))
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}
