/**
 * popup.js — Colophon popup (issue #30: 5 states)
 *
 * Visual layout matches the approved Sprint 1 design:
 *   - Header: doc title + settings gear
 *   - Originality verdict banner (good / warn / bad)
 *   - Breakdown card: Own writing / AI Paraphrase / External Source bars
 *   - Recent Activity timeline (3 most recent events)
 *   - Start/Stop, View full log, Export
 *   - Footer: "Private and local" + TWFF link
 *
 * Five rendered states:
 *   1. No session                — verdict hidden, breakdown empty, timeline empty
 *   2. Recording, no activity    — verdict "neutral" tone, bars at 0%
 *   3. Recording with activity   — verdict + bars + timeline populated
 *   4. Stopped, has events       — verdict + bars + timeline; Export enabled
 *   5. Error / SW unreachable    — notice banner shown
 */

import { exportTwff } from '../lib/export.js'

const $ = id => document.getElementById(id)

const ACTIVITY_FALLBACK = [
  { type: 'info', title: 'No activity yet', meta: ['Start recording in Google Docs to watch events.'] },
]

const TWFF_REPO = 'https://github.com/Functional-Intelligence-Research-Lab/twff'

// Keep popup data live while open
let _refreshTimer = null

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await refresh()

  _refreshTimer = setInterval(refresh, 1000)

  const settingsButton = $('btn-settings')
  if (settingsButton) {
    settingsButton.addEventListener('click', () => {
      chrome.runtime.openOptionsPage()
    })
  }

  const fullLogButton = $('btn-full-log')
  if (fullLogButton) {
    fullLogButton.addEventListener('click', async () => {
      try {
        const win = await chrome.windows.getCurrent()
        await chrome.sidePanel.open({ windowId: win.id })
        window.close()
      } catch (err) {
        console.error('[Colophon] Could not open side panel:', err.message)
        showNotice('Side panel could not open.')
      }
    })
  }

  const recordButton = $('btn-record')
  if (recordButton) {
    recordButton.addEventListener('click', async () => {
      const tab = await getActiveDocTab()
      const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
      const isRecording = state?.session?.isRecording

      if (isRecording) {
        await chrome.runtime.sendMessage({ type: 'SESSION_STOP' })
      } else {
        if (!tab) {
          showNotice('Open a Google Docs document first.')
          return
        }
        await chrome.runtime.sendMessage({ type: 'SESSION_START', tabId: tab.id, docUrl: tab.url })
      }

      await refresh()
    })
  }

  const exportButton = $('btn-export')
  if (exportButton) {
    exportButton.addEventListener('click', async () => {
      try {
        const result = await exportTwff()
        showNotice(`Exported ${result.filename}`, false)
      } catch (err) {
        console.error('[Colophon] Export failed:', err.message)
        showNotice('Start recording before exporting.')
      }
    })
  }

  const floatingButton = $('btn-floating')
  if (floatingButton) {
    floatingButton.addEventListener('click', async () => {
      const tab = await getActiveDocTab()
      if (!tab) {
        showNotice('Open a Google Docs document first.')
        return
      }

      try {
        await sendToContent(tab.id, { type: 'TOGGLE_FLOATING_PANEL' })
        window.close()
      } catch (err) {
        console.error('[Colophon] Could not toggle floating panel:', err.message)
        showNotice('Reload the document and try again.')
      }
    })
  }
})

window.addEventListener('unload', () => clearInterval(_refreshTimer))

async function refresh() {
  const tab = await getActiveDocTab()
  $('doc-title').textContent = formatDocTitle(tab?.title)

  let state = null
  try {
    state = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
  } catch {
    // The popup still renders the static dashboard if the worker is waking.
  }

  const session = state?.session ?? null
  renderScores(session)
  renderActivity(session)
  renderRecordButton(session, tab)

  const eventCount = session?.events?.length ?? 0
  $('btn-export').disabled = eventCount < 2
}

function renderRecordButton(session, tab) {
  const button = $('btn-record')
  if (!button) return

  const isRecording = session?.isRecording
  button.textContent = isRecording ? 'Stop recording' : 'Start recording'
  button.disabled = !tab && !isRecording

  if (isRecording) {
    button.classList.add('record-button--stop')
  } else {
    button.classList.remove('record-button--stop')
  }

  button.title = button.disabled ? 'Open a Google Docs document first.' : ''
}

function renderScores(session) {
  const events = session?.events ?? []
  const editCount = events.filter(event => event.type === 'edit').length
  const aiCount = events.filter(event => event.type === 'ai_interaction').length
  const sourceCount = events.filter(event => event.type === 'paste' || event.type === 'source').length
  const total = Math.max(1, editCount + aiCount + sourceCount)

  const own = session ? clampPercent(Math.round((editCount / total) * 100)) : 0
  const ai = session ? clampPercent(Math.round((aiCount / total) * 100)) : 0
  const source = session ? clampPercent(Math.round((sourceCount / total) * 100)) : 0

  setScore('own', own)
  setScore('ai', ai)
  setScore('source', source)
}

function setScore(id, value) {
  $(`score-${id}`).textContent = `${value}%`
  $(`bar-${id}`).style.width = `${Math.max(8, value)}%`
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value))
}

function renderActivity(session) {
  const items = activityFromSession(session)
  $('activity-list').innerHTML = items.map(ActivityItem).join('')
}

function activityFromSession(session) {
  const events = session?.events ?? []
  const mapped = events
    .filter(event => !['session_start', 'session_end', 'focus_change'].includes(event.type))
    .slice(-3)
    .reverse()
    .map(eventToActivity)

  return mapped.length ? mapped : ACTIVITY_FALLBACK
}

function eventToActivity(event) {
  if (event.type === 'info') {
    return { type: 'info', title: event.title, meta: event.meta }
  }
  if (event.type === 'ai_interaction') {
    return { type: 'ai', title: 'AI suggested an edit', meta: [relativeTime(event.timestamp)] }
  }
  if (event.type === 'paste') {
    return { type: 'source', title: 'You added a source', meta: [relativeTime(event.timestamp)] }
  }
  return { type: 'edit', title: 'You edited a paragraph', meta: [relativeTime(event.timestamp)] }
}

function ActivityItem(item) {
  const meta = item.meta.map((part, index) => (
    index === 0 ? `<span>${part}</span>` : `<span class="activity-dot">•</span><span>${part}</span>`
  )).join('')

  return `
    <article class="activity-item">
      <div class="activity-mark activity-mark--${item.type}">${activityIcon(item.type)}</div>
      <div class="activity-copy">
        <p class="activity-title">${item.title}</p>
        <p class="activity-meta">${meta}</p>
      </div>
    </article>
  `
}

function activityIcon(type) {
  if (type === 'edit') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.5 16.5 5a2.2 2.2 0 0 1 3.1 3.1L7.1 20.6 3.5 21l.5-3.5Z"/><path d="m14.5 7.1 2.4 2.4"/></svg>'
  }
  if (type === 'source') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 14.5 14.5 9.5"/><path d="M10.5 6.5 12 5a4 4 0 0 1 5.7 5.7l-2 2a4 4 0 0 1-5.7 0"/><path d="M13.5 17.5 12 19a4 4 0 0 1-5.7-5.7l2-2a4 4 0 0 1 5.7 0"/></svg>'
  }
  if (type === 'info') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><circle cx="12" cy="16.5" r=".5"/></svg>'
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2 5.5 5.5 2-5.5 2-2 5.5-2-5.5-5.5-2 5.5-2 2-5.5Z"/></svg>'
}


async function getActiveDocTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.url?.startsWith('https://docs.google.com/document/')) return null
  return tab
}

async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message)
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js'],
    })
    return chrome.tabs.sendMessage(tabId, message)
  }
}

function formatDocTitle(title = '') {
  return title
    .replace(/ - Google Docs$/i, '')
    .trim() || 'Untitled document'
}

function relativeTime(timestamp) {
  const then = new Date(timestamp).getTime()
  if (!Number.isFinite(then)) return 'Just now'

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60) return 'Just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

function showNotice(message, isError = true) {
  const notice = $('notice')
  notice.textContent = message
  notice.style.color = isError ? '#b42318' : '#2f955c'
  notice.hidden = false
  clearTimeout(notice._timer)
  notice._timer = setTimeout(() => {
    notice.hidden = true
  }, 2600)
}

refresh()
setInterval(refresh, 1200)
