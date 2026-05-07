/**
 * popup.js — toolbar popup logic
 *
 * Opens when the user clicks the Colophon icon.
 *
 * Start recording flow:
 *   1. Popup gets the active tab ID (activeTab permission, user-gesture context)
 *   2. Sends SESSION_START { tabId, docUrl } to the service worker
 *   3. SW creates session and tells the content script to ACTIVATE
 *
 * Stop recording flow:
 *   1. Popup sends SESSION_STOP to SW
 *   2. SW logs session_end and tells the content script to DEACTIVATE
 */

const $ = id => document.getElementById(id)

async function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, payload })
}

// ── State refresh ─────────────────────────────────────────────────────────────

async function refresh() {
  let state
  try {
    state = await send('GET_STATE')
  } catch {
    return // SW not ready yet — will refresh on next tick
  }
  if (!state) return

  const { session, stats } = state
  const recording = session?.isRecording ?? false

  $('status-dot').className     = `dot ${recording ? 'dot--active' : 'dot--stopped'}`
  $('status-label').textContent = recording ? 'Recording' : 'Stopped'
  $('btn-toggle').textContent   = recording ? 'Stop recording' : 'Start recording'

  const statsEl = $('stats')
  if (session) {
    statsEl.hidden                  = false
    $('stat-edits').textContent    = stats.editCount
    $('stat-ai').textContent       = stats.aiCount
    $('stat-duration').textContent = formatDuration(stats.elapsed)
  } else {
    statsEl.hidden = true
  }

  // Export requires at least one event beyond session_start
  const eventCount = session?.events?.length ?? 0
  $('btn-export').disabled = eventCount < 2
}

// ── Buttons ───────────────────────────────────────────────────────────────────

$('btn-toggle').addEventListener('click', async () => {
  const state = await send('GET_STATE')

  if (state?.session?.isRecording) {
    await send('SESSION_STOP')
  } else {
    const tab = await getActiveDocTab()
    if (!tab) {
      showNotice('Open a Google Docs document first.')
      return
    }
    await send('SESSION_START', { tabId: tab.id, docUrl: tab.url })
  }

  await refresh()
})

$('btn-export').addEventListener('click', async () => {
  try {
    const { log, error } = await send('EXPORT')
    if (error) throw new Error(error)
    downloadLog(log)
  } catch (err) {
    console.error('[Colophon] Export failed:', err.message)
  }
})

$('link-settings').addEventListener('click', e => {
  e.preventDefault()
  chrome.runtime.openOptionsPage()
})

$('link-status').addEventListener('click', e => {
  e.preventDefault()
  chrome.tabs.create({ url: chrome.runtime.getURL('status/status.html') })
})

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getActiveDocTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.url?.startsWith('https://docs.google.com/document/')) return null
  return tab
}

function showNotice(msg) {
  const el = document.createElement('p')
  el.style.cssText = 'font-size:11px;color:#e53e3e;padding:0 14px 10px;margin:0'
  el.textContent = msg
  document.querySelector('.actions').after(el)
  setTimeout(() => el.remove(), 3000)
}

function downloadLog(log) {
  const json = JSON.stringify(log, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url  = URL.createObjectURL(blob)
  const ts   = new Date().toISOString().slice(0, 16).replace('T', '-').replaceAll(':', '-')
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `colophon-${ts}.json`,
  })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function formatDuration(ms) {
  if (!ms) return '0:00'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ── Init ──────────────────────────────────────────────────────────────────────

refresh()
setInterval(refresh, 1000)
