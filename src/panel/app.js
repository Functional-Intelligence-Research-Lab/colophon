import { PANEL_CSS } from './panel.css.js'
import { icons } from './icons.js'
import { Composer, ProjectContext, TimelineItem } from './components.js'

const INITIAL_ITEMS = [
  {
    id: 'suggestion-main',
    type: 'suggestion',
    kind: 'ai',
    actor: 'AI',
    label: 'Suggestion',
    time: 'Just now',
    state: 'default',
    copy: 'Consider adding a concrete example to strengthen the claim.',
  },
  {
    id: 'edited-sentence',
    type: 'edit',
    kind: 'you',
    actor: 'You',
    label: 'Edited',
    time: '2m ago',
    copy: 'Added a sentence',
  },
  {
    id: 'paraphrased',
    type: 'paraphrase',
    kind: 'ai',
    actor: 'AI',
    label: 'Paraphrased',
    time: '4m ago',
  },
  {
    id: 'accepted',
    type: 'accepted',
    kind: 'you',
    actor: 'You',
    label: 'Accepted',
    time: '4m ago',
    copy: '',
  },
  {
    id: 'source',
    type: 'source',
    kind: 'ai',
    actor: 'AI',
    label: 'Source',
    time: '6m ago',
    copy: 'This source could back up your work',
    title: 'Ellen MacArthur Foundation',
    url: 'ellenmacarthurfoundation.org',
  },
  {
    id: 'image',
    type: 'image',
    kind: 'you',
    actor: 'You',
    label: 'Added Image',
    time: '7m ago',
  },
]

function cloneItems() {
  return INITIAL_ITEMS.map(item => ({ ...item }))
}

function render(state) {
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
        <div class="doc-title">Sustainable Packaging Proposal</div>
        <button class="icon-btn doc-menu" data-action="more" aria-label="Panel menu">${icons.dots}</button>
      </div>

      <main class="timeline">
        ${ProjectContext()}
        ${state.items.map(TimelineItem).join('')}
      </main>

      ${Composer()}
    </section>
  `
}

function nextStateForAction(state, action, formValue = '') {
  const items = state.items.map(item => ({ ...item }))
  const suggestion = items.find(item => item.id === 'suggestion-main')

  if (action === 'reset-demo') return { ...state, items: cloneItems() }
  if (!suggestion) return { ...state, items }

  if (action === 'use-suggestion') {
    suggestion.state = 'applying'
    setTimeout(() => state.dispatch('finish-apply'), 700)
  }

  if (action === 'finish-apply') suggestion.state = 'applied'
  if (action === 'view-changes') suggestion.state = 'changes'
  if (action === 'collapse-applied') suggestion.state = 'applied'
  if (action === 'dismiss-suggestion') suggestion.state = 'dismissed'
  if (action === 'undo-dismiss') suggestion.state = 'default'
  if (action === 'reply-suggestion') suggestion.state = 'replying'

  if (action === 'composer' && formValue.trim()) {
    suggestion.state = 'thread'
    suggestion.time = 'Just now'
  }

  return { ...state, items }
}

export function mountColophonPanel(host, options = {}) {
  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  host.append(style)

  const root = document.createElement('div')
  host.append(root)

  let state = {
    mode: options.mode ?? 'sidepanel',
    items: cloneItems(),
    dispatch,
  }

  function draw() {
    root.innerHTML = render(state)
  }

  function dispatch(action, detail = {}) {
    if (action === 'close-panel') {
      options.onClose?.()
      return
    }
    if (action === 'pin-panel') {
      options.onPin?.()
      return
    }
    state = nextStateForAction(state, action, detail.value)
    state.dispatch = dispatch
    draw()
  }

  root.addEventListener('click', event => {
    const buttonEl = event.target.closest('[data-action]')
    if (!buttonEl) return
    const action = buttonEl.dataset.action
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

  draw()

  return {
    destroy() {
      root.remove()
      style.remove()
    },
  }
}
