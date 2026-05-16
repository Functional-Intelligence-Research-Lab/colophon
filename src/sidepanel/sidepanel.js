/**
 * sidepanel.js — Full activity log view
 *
 * Opens when the user clicks "View full log" in the popup. Persists
 * during the session (unlike the popup, which closes on blur).
 * Refreshes every second so events appear as they happen.
 */

const $ = id => document.getElementById(id)

let _refreshTimer = null

document.addEventListener('DOMContentLoaded', () => {
  refresh()
  _refreshTimer = setInterval(refresh, 1000)
})

window.addEventListener('unload', () => clearInterval(_refreshTimer))

async function refresh() {
  let state
  try {
    state = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
  } catch {
    return
  }
  const session = state?.session ?? null
  renderHeader(session)
  renderSummary(session)
  renderTimeline(session?.events ?? [])
}

function renderHeader(session) {
  $('session-id').textContent = session
    ? `Session ${session.sessionId.slice(0, 8)}…`
    : ''
}

function renderSummary(session) {
  const wrap = $('summary')
  if (!session) { wrap.hidden = true; return }
  wrap.hidden = false

  const recordingChip = $('chip-recording')
  if (session.isRecording) {
    recordingChip.textContent = 'Recording'
    recordingChip.className   = 'chip'
  } else {
    recordingChip.textContent = 'Stopped'
    recordingChip.className   = 'chip chip--stopped'
  }

  $('chip-count').textContent    = `${session.events.length} event${session.events.length === 1 ? '' : 's'}`
  $('chip-duration').textContent = formatDuration(elapsed(session))
}

function elapsed(session) {
  if (!session.isRecording) {
    const end = session.events.find(e => e.type === 'session_end')?.timestamp
    if (end) return new Date(end).getTime() - new Date(session.startedAt).getTime()
    return 0
  }
  return Date.now() - new Date(session.startedAt).getTime()
}

function renderTimeline(events) {
  const list  = $('timeline')
  const empty = $('empty')

  if (events.length === 0) {
    empty.hidden = false
    list.querySelectorAll('.sp-item').forEach(n => n.remove())
    return
  }
  empty.hidden = true

  list.querySelectorAll('.sp-item').forEach(n => n.remove())
  // Show newest first
  for (const event of [...events].reverse()) {
    list.appendChild(renderItem(event))
  }
}

function renderItem(event) {
  const li = document.createElement('li')
  const { icon, label, meta, kind } = describe(event)
  li.className = `sp-item sp-item--${kind}`
  li.innerHTML = `
    <span class="sp-item__icon">${icon}</span>
    <span class="sp-item__body">
      <div class="sp-item__label"></div>
      <div class="sp-item__meta"></div>
    </span>`
  li.querySelector('.sp-item__label').textContent = label
  li.querySelector('.sp-item__meta').innerHTML    = meta
  return li
}

function describe(event) {
  const m  = event.meta || {}
  const ts = formatTime(event.timestamp)

  switch (event.type) {
    case 'session_start':
      return { kind: 'session', icon: '▶', label: 'Session started', meta: ts }
    case 'session_end':
      return { kind: 'session', icon: '■', label: 'Session ended',   meta: ts }
    case 'edit': {
      const d = m.char_delta ?? 0
      return {
        kind:  'edit',
        icon:  '✎',
        label: d >= 0 ? `Added ${d} character${d === 1 ? '' : 's'}` : `Deleted ${-d} character${-d === 1 ? '' : 's'}`,
        meta:  `<strong>edit</strong> · ${ts}`,
      }
    }
    case 'paste':
      return {
        kind:  'paste',
        icon:  '⎘',
        label: `Pasted ${m.char_count ?? 0} character${m.char_count === 1 ? '' : 's'}`,
        meta:  `<strong>${m.source ?? 'external'}</strong> · ${ts}`,
      }
    case 'ai_interaction':
      return {
        kind:  'ai',
        icon:  '✦',
        label: `AI ${m.interaction_type ?? 'interaction'} — ${m.acceptance ?? 'pending'}`,
        meta:  `<strong>${m.model ?? 'unknown model'}</strong> · ${ts}`,
      }
    case 'focus_change':
      return {
        kind:  'focus',
        icon:  '○',
        label: `Away for ${Math.round((m.duration_ms ?? 0) / 1000)}s`,
        meta:  ts,
      }
    case 'checkpoint':
      return {
        kind:  'session',
        icon:  '●',
        label: 'Checkpoint',
        meta:  `${m.char_count_total ?? 0} chars · ${ts}`,
      }
    default:
      return { kind: 'session', icon: '·', label: event.type, meta: ts }
  }
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
