import { exportTwff } from '../lib/export.js'

const $ = id => document.getElementById(id)

const ACTIVITY_FALLBACK = [
  { type: 'ai', title: 'AI suggested a rephrase', meta: ['2m ago', 'You dismissed'] },
  { type: 'edit', title: 'You edited a paragraph', meta: ['2m ago'] },
  { type: 'source', title: 'You added a source', meta: ['2m ago'] },
  { type: 'ai', title: 'AI suggested an example', meta: ['2m ago', 'You dismissed'] },
]

async function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, payload })
}

async function refresh() {
  const tab = await getActiveDocTab()
  $('doc-title').textContent = formatDocTitle(tab?.title)

  let state = null
  try {
    state = await send('GET_STATE')
  } catch {
    // The popup still renders the static dashboard if the worker is waking.
  }

  const session = state?.session ?? null
  renderScores(session)
  renderActivity(session)

  const eventCount = session?.events?.length ?? 0
  $('btn-export').disabled = eventCount < 2
}

function renderScores(session) {
  const events = session?.events ?? []
  const editCount = events.filter(event => event.type === 'edit').length
  const aiCount = events.filter(event => event.type === 'ai_interaction').length
  const sourceCount = events.filter(event => event.type === 'paste' || event.type === 'source').length
  const total = Math.max(1, editCount + aiCount + sourceCount)

  const own = session ? clampPercent(Math.round((editCount / total) * 100)) : 80
  const ai = session ? clampPercent(Math.round((aiCount / total) * 100)) : 80
  const source = session ? clampPercent(Math.round((sourceCount / total) * 100)) : 80

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
    .slice(-4)
    .reverse()
    .map(eventToActivity)

  return mapped.length ? mapped : ACTIVITY_FALLBACK
}

function eventToActivity(event) {
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
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2 5.5 5.5 2-5.5 2-2 5.5-2-5.5-5.5-2 5.5-2 2-5.5Z"/></svg>'
}

$('btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})

$('btn-full-log').addEventListener('click', async () => {
  try {
    const win = await chrome.windows.getCurrent()
    await chrome.sidePanel.open({ windowId: win.id })
    window.close()
  } catch (err) {
    console.error('[Colophon] Could not open side panel:', err.message)
    showNotice('Side panel could not open.')
  }
})

$('btn-export').addEventListener('click', async () => {
  try {
    const result = await exportTwff()
    showNotice(`Exported ${result.filename}`, false)
  } catch (err) {
    console.error('[Colophon] Export failed:', err.message)
    showNotice('Start recording before exporting.')
  }
})

$('btn-floating').addEventListener('click', async () => {
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
