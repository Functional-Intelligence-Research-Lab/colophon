/**
 * popup.js — Colophon popup
 *
 * Layout: header (doc title + settings gear), a plain recording-status
 * banner (no verdict, no judgment), breakdown card (Own writing / AI
 * Paraphrase / External Source bars — the actual evidence), Recent Activity
 * timeline (3 most recent events), Start/Stop, View full log, Export,
 * footer ("Private and local" + TWFF link).
 *
 * Five rendered states:
 *   1. No session                — banner "Nothing recorded yet", breakdown empty, timeline empty
 *   2. Recording, no activity    — banner "Nothing recorded yet", bars at 0%
 *   3. Recording with activity   — banner "recorded" + bars + timeline populated
 *   4. Stopped, has events       — banner "recorded" + bars + timeline; Export enabled
 *   5. Error / SW unreachable    — notice banner shown
 */

import { exportTwff } from '../lib/export.js'
import { classifyEuLabel, summariseSession, euIconPath, euLabelText, EU_LABEL, EVIDENCE_BASIS, SELF_REPORTED_ONLY_REASON } from '../lib/eu-ai-label.js'
import { formatDocTitle } from '../shared/doc-title.js'
import { esc } from '../shared/esc.js'

const $ = id => document.getElementById(id)

const ACTIVITY_FALLBACK = [
  { type: 'info', title: 'No activity yet', meta: ['Start recording in Google Docs to watch events.'] },
]

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
    fullLogButton.addEventListener('click', async (e) => {
      e.preventDefault()
      try {
        const sidebar = globalThis.browser?.sidebarAction ?? chrome.sidebarAction
        // Firefox uses sidebarAction; must be called synchronously inside user gesture
        if (sidebar?.open) {
          await sidebar.open()
          window.close()
          return
        }

        // Chrome uses sidePanel
        if (chrome.sidePanel?.open) {
          const win = await chrome.windows.getCurrent()
          await chrome.sidePanel.open({ windowId: win.id })
          window.close()
          return
        }

        // Fallback: open side panel UI in a tab
        chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') })
        window.close()
      } catch (err) {
        console.error('[Colophon] Could not open side panel:', err)
        try {
          chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') })
          window.close()
        } catch {
          showNotice('Side panel could not open.')
        }
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
        await chrome.runtime.sendMessage({
          type: 'SESSION_START', tabId: tab.id, docUrl: tab.url, title: formatDocTitle(tab.title),
        })
      }

      await refresh()
    })
  }

  const exportButton = $('btn-export')
  if (exportButton) {
    const exportLabel = exportButton.querySelector('.btn-label')
    exportButton.addEventListener('click', async () => {
      const originalText = exportLabel.textContent;
      exportLabel.textContent = 'Exporting…';
      exportButton.disabled = true;
      try {
        const result = await exportTwff()
        exportLabel.textContent = 'Exported';
        showNotice(`Exported ${result.filename}`, false)
        setTimeout(() => {
          exportLabel.textContent = originalText;
          exportButton.disabled = false;
        }, 2000);
      } catch (err) {
        console.error('[Colophon] Export failed:', err.message)
        exportLabel.textContent = originalText;
        exportButton.disabled = false;
        showNotice('Start recording before exporting.')
      }
    })
  }

  const viewerButton = $('btn-viewer')
  if (viewerButton) {
    viewerButton.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') + '?live=1' })
      window.close()
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
  renderTooltip(session)

  const eventCount = session?.events?.length ?? 0
  $('btn-export').disabled = eventCount < 2
}

function renderTooltip(session) {
  const tooltipInfo = $('tooltip-info')
  if (!tooltipInfo) return

  tooltipInfo.textContent = session?.isRecording
    ? 'Recording: your edits are being tracked'
    : 'Start recording before you edit the document'
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
  // Character-weighted, not event-counted: a single one-character edit and a
  // single 2,000-character accepted AI paragraph used to both count as "1"
  // toward their bucket, so these bars could show e.g. "90% own writing"
  // when the AI content was actually most of the document's text.
  // summariseSession() already does this correctly for the EU-label math
  // below (ai_chars kept, scaled by similarity_score when the author
  // reworded it) — reuse the same numbers here instead of a second, cruder
  // count.
  const { humanChars, observedAiChars, selfReportedAiChars } = summariseSession(events)
  // The "source" bar is deliberately broader than selfReportedAiChars above:
  // it's every pasted character regardless of disclosure (a mechanism
  // question — "how much was pasted in" — not a disclosure question), so a
  // paste with no source_tool at all, or an explicit 'not_ai' self-report,
  // still shows up here even though it contributes to neither EU-label
  // bucket.
  const sourceChars = events
    .filter(event => event.type === 'paste' || event.type === 'source')
    .reduce((sum, event) => sum + Math.max(0, event.meta?.char_count ?? 0), 0)
  const hasData = humanChars + observedAiChars + sourceChars > 0
  const total = Math.max(1, humanChars + observedAiChars + sourceChars)

  const own = session ? clampPercent(Math.round((humanChars / total) * 100)) : 0
  const ai = session ? clampPercent(Math.round((observedAiChars / total) * 100)) : 0
  const source = session ? clampPercent(Math.round((sourceChars / total) * 100)) : 0

  setScore('own', own)
  setScore('ai', ai)
  setScore('source', source)
  renderSummaryBanner(hasData)
  // The EU label is classified from the real underlying character counts
  // (including disclosed-AI paste content via selfReportedAiChars), not
  // from the three bars' own rounded percentages — those bars answer "how
  // was this text produced" (typed / quick-action / pasted), a different
  // question from "was AI involvement disclosed," and conflating the two
  // was the exact bug this fixes: a session that's entirely one disclosed
  // AI paste used to show "source: 100%, ai: 0%" on the bars AND "no AI
  // contribution recorded" from the label — both technically following
  // from the old numbers, neither true.
  renderEuLabel({ hasSession: !!session, humanChars, observedAiChars, selfReportedAiChars })
}

// Informational EU AI-disclosure label. Suggests the European Commission's
// AI-labelling icon that matches this session's composition. It is a
// suggestion only — Colophon can't know whether a document falls within AI Act
// Article 50 scope, so the author decides whether to apply it. Never written to
// the log or auto-applied here.
function renderEuLabel({ hasSession, humanChars, observedAiChars, selfReportedAiChars }) {
  const wrap = $('eu-label')
  if (!wrap) return
  const icon = $('eu-label-icon')
  const text = $('eu-label-text')
  const none = $('eu-label-none')

  // Only show the row once a session exists; before that the popup is the
  // static dashboard and a disclosure suggestion would be meaningless.
  if (!hasSession) {
    wrap.hidden = true
    return
  }
  wrap.hidden = false

  const { label, aiShare, evidenceBasis } = classifyEuLabel({ humanChars, observedAiChars, selfReportedAiChars })
  const aiPct = Math.round(aiShare * 100)

  wrap.title = euLabelReason(label, aiPct, evidenceBasis)

  if (label === EU_LABEL.NONE) {
    // Session recorded, but no AI in the breakdown — muted "no label" state
    // rather than hiding, so the feature stays discoverable.
    if (icon) icon.hidden = true
    if (text) text.textContent = ''
    if (none) none.hidden = false
    return
  }

  if (none) none.hidden = true
  const path = euIconPath(label)          // extension-relative, e.g. assets/eu-icons/ai-modified-black.svg
  if (icon && path) {
    icon.src = `../${path}`
    icon.alt = euLabelText(label)
    icon.hidden = false
  }
  // Self-report-only evidence gets the hedged text in place of the plain
  // label name, so a bare "AI generated" never appears without the caveat
  // that it rests on a self-report, not anything Colophon verified.
  if (text) text.textContent = evidenceBasis === EVIDENCE_BASIS.SELF_REPORTED
    ? euLabelText(label) + ' (self-reported)'
    : euLabelText(label)
}

// Plain-language "why" for the hover tooltip on the suggested-label row.
// evidenceBasis === SELF_REPORTED gets the SAME frozen hedge regardless of
// label/share — see eu-ai-label.js's SELF_REPORTED_ONLY_REASON — precisely
// so a stronger-sounding label never comes with a more confident-sounding
// reason just because the share happened to be higher.
function euLabelReason(label, aiPct, evidenceBasis) {
  if (evidenceBasis === EVIDENCE_BASIS.SELF_REPORTED) return SELF_REPORTED_ONLY_REASON
  const tail = ' This is a suggestion from your recorded session — you decide whether it applies.'
  switch (label) {
    case EU_LABEL.AI_GENERATED:
      return `Suggested: "AI generated". Nearly all recorded activity (${aiPct}%) came from AI, with little or no writing of your own.` + tail
    case EU_LABEL.AI_MODIFIED:
      return `Suggested: "AI modified". AI made up ${aiPct}% of recorded activity, mixed with your own writing.` + tail
    case EU_LABEL.AI:
      return `Suggested: "AI". AI was involved but made up only ${aiPct}% of recorded activity.` + tail
    default:
      return 'No AI contribution recorded in this session, so no EU AI label is suggested.'
  }
}

// Single filled path (not stroke-based, since .leaf-mark svg forces
// fill:currentColor; stroke:none) — a plain document mark, not a judgment
// icon. The own/AI/source breakdown below is the actual evidence; this
// banner only states whether anything's been recorded yet.
const DOC_ICON_PATH = '<path d="M19.5 4.5C11.8 4.5 6 8.9 6 15.5c0 1.1.3 2.1.8 3 1-.7 2.1-1.3 3.4-1.8 3-1.1 5.1-3 6.2-5.7-2.4 2-5.1 3-8.1 3.1 1.9-4 5.6-6.1 11.2-6.4v-3.2Z"/>'

// Deliberately no verdict tiers here — no "mostly original" / "mostly
// AI-assisted" framing, no color-coded good/warn states. Just whether
// there's anything recorded yet; the breakdown bars carry the real data.
function renderSummaryBanner(hasData) {
  const banner = $('summary-banner')
  const icon = $('verdict-icon')
  const title = $('summary-title')
  if (!banner || !icon || !title) return

  icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${DOC_ICON_PATH}</svg>`
  title.innerHTML = hasData
    ? 'Writing activity <strong>recorded</strong>'
    : 'Nothing recorded <strong>yet</strong>'
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
  // title/meta are hardcoded literals for every real event type today (the
  // 'info' branch in eventToActivity() that passes raw event.title/
  // event.meta through is currently dead code, no producer emits it) — but
  // escaping here means that stays true if that ever changes, rather than
  // this privileged extension page becoming a stored-XSS sink the moment it
  // does.
  const meta = item.meta.map((part, index) => (
    index === 0 ? `<span>${esc(part)}</span>` : `<span class="activity-dot">•</span><span>${esc(part)}</span>`
  )).join('')

  return `
    <article class="activity-item">
      <div class="activity-mark activity-mark--${item.type}">${activityIcon(item.type)}</div>
      <div class="activity-copy">
        <p class="activity-title">${esc(item.title)}</p>
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

// Test seam only.
export { ActivityItem, eventToActivity }

