import { PANEL_CSS } from './panel.css.js'
import { icons } from './icons.js'
import { Composer, ProjectContext, TimelineItem } from './components.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(isoString) {
  const diffMs = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ago`
}

// ── Event → panel item ────────────────────────────────────────────────────────

function eventToItem(evt) {
  const time = relativeTime(evt.timestamp)
  const id = evt.timestamp
  const meta = evt.meta ?? {}

  switch (evt.type) {
    case 'edit':
      return {
        id, type: 'edit', kind: 'you', actor: 'You', label: 'Edited', time,
        copy: meta.content_after
          ? `"${meta.content_after.slice(0, 60)}"`
          : `${meta.delta_words || 0} words edited`,
      }

    case 'paste':
      return {
        id, type: 'edit', kind: 'you', actor: 'You', label: 'Pasted', time,
        copy: meta.content_preview || `${meta.char_count || 0} chars pasted`,
      }

    case 'image_upload':
      return { id, type: 'image', kind: 'you', actor: 'You', label: 'Added Image', time }

    case 'ai_suggestion': {
      const raw = meta.status
      const state = raw === 'used' ? 'applied' : raw === 'dismissed' ? 'dismissed' : 'default'
      return {
        id, type: 'suggestion', kind: 'ai', actor: 'AI', label: 'Suggestion', time,
        state, copy: meta.text || meta.output_preview || '',
      }
    }

    case 'ai_interaction':
      if (meta.acceptance === 'fully_accepted') {
        return { id, type: 'accepted', kind: 'you', actor: 'You', label: 'Accepted', time, copy: '' }
      }
      // rejected/dismissed interactions are handled via suggestion state
      return null

    default:
      return null
  }
}

function eventsToItems(events, localOverrides) {
  return [...events]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map(eventToItem)
    .filter(Boolean)
    .map(item => {
      const ov = localOverrides.get(item.id)
      return ov ? { ...item, ...ov } : item
    })
}

// ── Render ────────────────────────────────────────────────────────────────────

function render(state) {
  const items = state.items.length > 0
    ? state.items.map(TimelineItem).join('')
    : `<p style="color:#9ca3af;font-size:12px;padding:8px 0">No activity yet — start recording to see events here.</p>`

  return `
    <section class="colophon-panel ${state.mode === 'floating' ? 'colophon-panel--floating' : ''}">
      <header class="colophon-topbar ${state.mode === 'floating' ? 'drag-handle' : ''}" data-role="drag-handle">
        <div class="colophon-brand">
          <span class="colophon-logo">${icons.logo}</span>
          <span>Colophon</span>
        </div>
        <div class="colophon-tools">
          <button class="icon-btn" data-action="reset-demo" aria-label="Reset panel">${icons.refresh}</button>
          ${state.mode === 'floating' ? `<button class="icon-btn" data-action="pin-panel" aria-label="Pin panel">${icons.pin}</button>` : ''}
          ${state.mode === 'floating' ? `<button class="icon-btn" data-action="close-panel" aria-label="Close panel">${icons.close}</button>` : ''}
        </div>
      </header>

      <div class="docbar">
        ${icons.doc}
        <div class="doc-title">${state.docTitle}</div>
        <button class="icon-btn doc-menu" data-action="more" aria-label="Panel menu">${icons.dots}</button>
      </div>

      <main class="timeline">
        ${ProjectContext({ title: state.docTitle, prompt: state.assignmentPrompt ?? '' })}
        ${items}
      </main>

      ${Composer()}
    </section>
  `
}

// ── Mount ─────────────────────────────────────────────────────────────────────

export function mountColophonPanel(host, options = {}) {
  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  host.append(style)

  const root = document.createElement('div')
  host.append(root)

  // Raw events from the service worker — source of truth
  let _rawEvents = []

  // UI-only state overrides keyed by event timestamp (the item id)
  const localOverrides = new Map()

  const chromeApi = typeof chrome !== 'undefined' ? chrome : null

  let state = {
    mode: options.mode ?? 'sidepanel',
    items: [],
    docTitle: options.docTitle ?? 'Untitled document',
    assignmentPrompt: '',
    dispatch,
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  function draw() {
    root.innerHTML = render(state)

    // Close: directly remove the shadow host from the light DOM so it works
    // regardless of how deep the shadow boundary goes.
    const closeBtn = root.querySelector('[data-action="close-panel"]')
    if (closeBtn) {
      closeBtn.onclick = () => {
        options.onClose?.()
        const sr = root.getRootNode()
        if (sr instanceof ShadowRoot) sr.host.remove()
        else host.closest('[id^="colophon"]')?.remove()
      }
    }

    root.querySelector('[data-action="pin-panel"]')
      ?.addEventListener('click', () => options.onPin?.())
  }

  function applyEvents(events) {
    _rawEvents = events
    state = { ...state, items: eventsToItems(_rawEvents, localOverrides) }
    state.dispatch = dispatch
    draw()
  }

  // ── Chrome messaging ────────────────────────────────────────────────────────

  function sendToSW(payload) {
    chromeApi?.runtime.sendMessage(payload).catch(() => {})
  }

  function onRuntimeMessage(msg) {
    if (msg.action === 'SYNC_TIMELINE' && msg.events) {
      applyEvents(msg.events)
    }
  }

  // Debounced prompt save
  let _promptSaveTimer = null
  function savePrompt(text) {
    clearTimeout(_promptSaveTimer)
    _promptSaveTimer = setTimeout(() => {
      sendToSW({ action: 'UPDATE_METADATA', payload: { key: 'assignment_prompt', value: text } })
    }, 600)
  }

  // Always draw immediately so the panel shell (including close button) exists
  draw()

  if (chromeApi) {
    // Then populate with real session data
    chromeApi.runtime.sendMessage({ action: 'GET_STATE' }).then(response => {
      let changed = false
      if (response?.session?.events) {
        _rawEvents = response.session.events
        state = { ...state, items: eventsToItems(_rawEvents, localOverrides) }
        changed = true
      }
      if (response?.session?.metadata?.assignment_prompt) {
        state = { ...state, assignmentPrompt: response.session.metadata.assignment_prompt }
        changed = true
      }
      if (changed) { state.dispatch = dispatch; draw() }
    }).catch(() => {})

    // Stream new events as they arrive
    chromeApi.runtime.onMessage.addListener(onRuntimeMessage)
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  function dispatch(action, detail = {}) {
    if (action === 'close-panel') { options.onClose?.(); return }
    if (action === 'pin-panel')   { options.onPin?.(); return }

    const suggestion = state.items.find(i => i.type === 'suggestion')
    const suggId = suggestion?.id

    // ── Suggestion lifecycle ──
    if (action === 'use-suggestion' && suggId) {
      localOverrides.set(suggId, { state: 'applying' })
      applyEvents(_rawEvents)
      options.onUseSuggestion?.(suggestion.copy)
      sendToSW({ action: 'UPDATE_EVENT_STATE', payload: { eventTimestamp: suggId, status: 'used' } })
      setTimeout(() => {
        localOverrides.set(suggId, { state: 'applied' })
        applyEvents(_rawEvents)
      }, 700)
      return
    }

    if (action === 'dismiss-suggestion' && suggId) {
      localOverrides.set(suggId, { state: 'dismissed' })
      applyEvents(_rawEvents)
      sendToSW({ action: 'UPDATE_EVENT_STATE', payload: { eventTimestamp: suggId, status: 'dismissed' } })
      return
    }

    if (action === 'undo-dismiss' && suggId) {
      localOverrides.delete(suggId)
      applyEvents(_rawEvents)
      return
    }

    if (action === 'view-changes' && suggId) {
      localOverrides.set(suggId, { state: 'changes' })
      applyEvents(_rawEvents)
      return
    }

    if (action === 'collapse-applied' && suggId) {
      localOverrides.set(suggId, { state: 'applied' })
      applyEvents(_rawEvents)
      return
    }

    if (action === 'reply-suggestion' && suggId) {
      localOverrides.set(suggId, { state: 'replying' })
      applyEvents(_rawEvents)
      return
    }

    if (action === 'composer' && detail.value?.trim() && suggId) {
      localOverrides.set(suggId, { state: 'thread', time: 'Just now' })
      applyEvents(_rawEvents)
      return
    }

    // ── Dev / debug ──
    if (action === 'reset-demo') {
      localOverrides.clear()
      applyEvents(_rawEvents)
      return
    }
  }

  // ── Event listeners ─────────────────────────────────────────────────────────

  root.addEventListener('click', event => {
    const btn = event.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action
    if (action === 'composer') return
    dispatch(action)
  })

  root.addEventListener('submit', event => {
    const form = event.target.closest('[data-action="composer"]')
    if (!form) return
    event.preventDefault()
    const input = form.querySelector('input')
    dispatch('composer', { value: input?.value ?? '' })
  })

  root.addEventListener('input', event => {
    const field = event.target.closest('[data-action="edit-prompt"]')
    if (!field) return
    const text = field.textContent ?? ''
    state = { ...state, assignmentPrompt: text }
    savePrompt(text)
  })

  return {
    destroy() {
      if (chromeApi) chromeApi.runtime.onMessage.removeListener(onRuntimeMessage)
      root.remove()
      style.remove()
    },
  }
}
