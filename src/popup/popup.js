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

const TWFF_REPO = 'https://github.com/Functional-Intelligence-Research-Lab/twff'

// Keep popup data live while open
let _refreshTimer = null

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  $('link-twff').href = TWFF_REPO

  await setBrandTooltip()
  await refresh()

  _refreshTimer = setInterval(refresh, 1000)

  $('link-settings').addEventListener('click', e => {
    e.preventDefault()
    chrome.runtime.openOptionsPage()
  })

  $('btn-toggle').addEventListener('click', onToggleClick)
  $('btn-export').addEventListener('click', onExportClick)
  $('btn-view-log').addEventListener('click', onViewLogClick)
})

window.addEventListener('unload', () => clearInterval(_refreshTimer))

// ── State refresh ─────────────────────────────────────────────────────────────

async function refresh() {
  let state
  try {
    state = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
  } catch {
    return showNotice('Service worker not reachable. Reload the extension.')
  }
  if (!state) return

  const session   = state.session ?? null
  const events    = session?.events ?? []
  const recording = session?.isRecording ?? false

  renderToggle(recording, !!session)
  renderVerdict(events, recording)
  renderBreakdown(events)
  renderTimeline(events)

  // Export needs at least one event past session_start
  $('btn-export').disabled = events.length < 2
}

// ── Toggle button ─────────────────────────────────────────────────────────────

function renderToggle(recording, hasSession) {
  const btn = $('btn-toggle')
  if (recording) {
    btn.textContent = 'Stop recording'
    btn.classList.remove('btn--primary'); btn.classList.add('btn--secondary')
  } else {
    btn.textContent = hasSession ? 'Start a new session' : 'Start recording'
    btn.classList.add('btn--primary'); btn.classList.remove('btn--secondary')
  }
}

async function onToggleClick() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch(() => null)
  if (state?.session?.isRecording) {
    await chrome.runtime.sendMessage({ type: 'SESSION_STOP' })
  } else {
    const tab = await getActiveDocTab()
    if (!tab) return showNotice('Open a Google Docs document first.')
    await chrome.runtime.sendMessage({ type: 'SESSION_START', payload: { tabId: tab.id, docUrl: tab.url } })
  }
  await refresh()
}

// ── Verdict banner ────────────────────────────────────────────────────────────

function renderVerdict(events, recording) {
  const banner    = $('verdict')
  const labelEl   = $('verdict-label')
  const subEl     = $('verdict-subtitle')

  const { ai, source } = computeRatios(events)

  let tone = 'good', label = 'mostly original', subtitle = 'AI is used lightly for editing'

  if (events.length <= 1) {
    tone     = 'good'
    label    = recording ? 'recording' : 'not yet started'
    subtitle = recording ? 'Activity will appear here as you write.' : 'Press Start to begin a session.'
  } else if (ai > 0.5 || (ai + source) > 0.7) {
    tone     = 'bad'
    label    = 'heavily AI-assisted'
    subtitle = `${Math.round(ai * 100)}% of changes came from AI`
  } else if (ai > 0.25 || source > 0.3) {
    tone     = 'warn'
    label    = 'mixed authorship'
    subtitle = 'A meaningful portion came from AI or external sources'
  } else {
    tone     = 'good'
    label    = 'mostly original'
    subtitle = ai > 0 ? 'AI is used lightly for editing' : 'No AI assistance recorded'
  }

  banner.classList.remove('verdict--good', 'verdict--warn', 'verdict--bad')
  banner.classList.add(`verdict--${tone}`)
  labelEl.textContent = label
  subEl.textContent   = subtitle
}

// ── Breakdown bars ────────────────────────────────────────────────────────────

function renderBreakdown(events) {
  const { own, ai, source } = computeRatios(events)
  setBar('own',    own)
  setBar('ai',     ai)
  setBar('source', source)
}

function setBar(key, ratio) {
  const pct = Math.round(ratio * 100)
  $(`bar-${key}`).style.width   = `${pct}%`
  $(`pct-${key}`).textContent   = `${pct}%`
}

function computeRatios(events) {
  let ownChars = 0, aiChars = 0, sourceChars = 0
  for (const e of events) {
    const m = e.meta || {}
    if (e.type === 'edit')           ownChars    += Math.abs(m.char_delta ?? 0)
    else if (e.type === 'paste')     sourceChars += m.char_count ?? 0
    else if (e.type === 'ai_interaction') aiChars += m.output_length ?? 0
  }
  const total = ownChars + aiChars + sourceChars
  if (total === 0) return { own: 0, ai: 0, source: 0 }
  return {
    own:    ownChars    / total,
    ai:     aiChars     / total,
    source: sourceChars / total,
  }
}

// ── Recent activity timeline ──────────────────────────────────────────────────

function renderTimeline(events) {
  const list  = $('timeline')
  const empty = $('timeline-empty')

  // Show 3 most recent events that are not session_start / session_end
  const visible = events
    .filter(e => e.type !== 'session_start' && e.type !== 'session_end')
    .slice(-3)
    .reverse()

  if (visible.length === 0) {
    empty.hidden = false
    list.querySelectorAll('.timeline__item').forEach(n => n.remove())
    return
  }
  empty.hidden = true

  list.querySelectorAll('.timeline__item').forEach(n => n.remove())
  for (const event of visible) list.appendChild(renderTimelineItem(event))
}

function renderTimelineItem(event) {
  const li = document.createElement('li')
  li.className = 'timeline__item'

  const meta = event.meta || {}
  const ago  = formatAgo(event.timestamp)
  let iconKind, iconSvg, label, statusText = ''

  switch (event.type) {
    case 'ai_interaction':
      iconKind   = 'ai'
      iconSvg    = sparkleSvg()
      label      = labelForAi(meta)
      statusText = labelForAcceptance(meta.acceptance)
      break
    case 'paste':
      iconKind   = 'source'
      iconSvg    = linkSvg()
      label      = 'You added a source'
      break
    case 'edit':
    default:
      iconKind   = 'edit'
      iconSvg    = pencilSvg()
      label      = 'You edited a paragraph'
      break
  }

  li.innerHTML = `
    <span class="timeline__icon timeline__icon--${iconKind}">${iconSvg}</span>
    <span class="timeline__body">
      <div class="timeline__label"></div>
      <div class="timeline__meta">
        <span class="timeline__meta__ago"></span>${statusText ? '<span class="timeline__meta__sep">·</span><span class="timeline__meta__status"></span>' : ''}
      </div>
    </span>`
  li.querySelector('.timeline__label').textContent = label
  li.querySelector('.timeline__meta__ago').textContent = ago
  if (statusText) li.querySelector('.timeline__meta__status').textContent = statusText
  return li
}

function labelForAi(meta) {
  const verbs = { paraphrase: 'rephrase', draft: 'a draft', summarize: 'a summary', expand: 'an expansion', continue: 'a continuation', completion: 'a completion', brainstorm: 'an example' }
  return `AI suggested ${verbs[meta.interaction_type] ?? 'a change'}`
}

function labelForAcceptance(a) {
  if (a === 'fully_accepted')     return 'You accepted'
  if (a === 'partially_accepted') return 'You partially accepted'
  if (a === 'modified')           return 'You modified it'
  if (a === 'rejected')           return 'You dismissed'
  return ''
}

// ── Inline SVG icons ──────────────────────────────────────────────────────────

function sparkleSvg() {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/>
    <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"/>
  </svg>`
}

function pencilSvg() {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 20h9"/>
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
  </svg>`
}

function linkSvg() {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </svg>`
}

// ── Buttons (export, view full log) ───────────────────────────────────────────

async function onExportClick() {
  try {
    const result = await exportTwff()
    showNotice(`Exported ${result?.filename ?? 'file'}`, 'good')
  } catch (err) {
    showNotice(`Export failed: ${err.message}`)
  }
}

async function onViewLogClick() {
  // Per issue #30: "View full log" navigates to the side panel
  const tab = await getActiveTabAny()
  try {
    await chrome.sidePanel.open({ windowId: tab?.windowId })
  } catch {
    // sidePanel.open requires a user gesture (we have one) and the API to exist
    showNotice('Side panel unavailable. Reload the extension.')
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getActiveDocTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.url?.startsWith('https://docs.google.com/document/')) return null
  return tab
}

async function getActiveTabAny() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

async function setBrandTooltip() {
  // Brand stays as "Colophon"; the active doc title moves to the tooltip
  // so it's still discoverable on hover without competing with the wordmark.
  const tab = await getActiveTabAny()
  if (!tab?.title) return
  const clean = tab.title.replace(/\s*[-–]\s*Google\s*Docs.*$/i, '').trim()
  if (clean) $('brand').title = `Colophon — ${clean}`
}

function showNotice(msg, tone = 'bad') {
  const existing = document.querySelector('.notice')
  if (existing) existing.remove()
  const el = document.createElement('p')
  el.className = 'notice'
  el.style.color = tone === 'good' ? 'var(--c-good-fg)' : 'var(--c-bad-fg)'
  el.textContent = msg
  document.querySelector('.actions').after(el)
  setTimeout(() => el.remove(), 3000)
}

function formatAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const s  = Math.max(0, Math.floor(ms / 1000))
  if (s < 60)        return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60)        return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)        return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
