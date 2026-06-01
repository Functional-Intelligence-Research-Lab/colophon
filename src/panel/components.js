import { icons } from './icons.js'

function button(label, className, action, icon = '') {
  return `<button class="button ${className}" data-action="${action}">${icon}${label}</button>`
}

function mark(item) {
  if (item.type === 'accepted') {
    return `<div class="mark mark--accepted">${icons.check}</div>`
  }
  const icon = item.kind === 'quiet' ? icons.blocked : icons.spark
  return `<div class="mark mark--${item.kind}">${icon}</div>`
}

function head(item) {
  const actorClass = item.kind === 'you' ? 'actor--you' : item.kind === 'quiet' ? 'actor--quiet' : ''
  return `
    <div class="item-head">
      <span class="actor ${actorClass}">${item.actor}</span>
      <span>${item.label}</span>
      <span class="time">${item.time}</span>
    </div>
  `
}

function suggestionCard(item) {
  if (item.state === 'applying') {
    return `
      <div class="card card--ai">
        <div class="item-head"><span class="actor">AI</span><span>Applying</span><span class="time">${item.time}</span></div>
        <p class="card-copy">Applying to document...</p>
        <div class="progress"><span></span></div>
      </div>
    `
  }

  if (item.state === 'applied') {
    return `
      <div class="card card--applied">
        <div class="item-head"><span class="actor actor--you">${icons.check} AI</span><span>Applied</span><span class="time">${item.time}</span></div>
        <p class="card-copy">Concrete example added.</p>
        <p class="card-note">You can edit it anytime.</p>
        <button class="button button--ghost" data-action="view-changes">View changes ${icons.chevron}</button>
      </div>
    `
  }

  if (item.state === 'changes') {
    return `
      <div class="card card--applied">
        <div class="item-head"><span class="actor actor--you">${icons.check} AI</span><span>Applied</span><span class="time">${item.time}</span></div>
        <div class="diff">
          <div class="diff-line diff-line--old">Many companies are looking at ways to reduce their environmental impact...</div>
          <div class="diff-line diff-line--new">For example, Patagonia redesigned its packaging in 2022, eliminating 80% of virgin plastic from shipments...</div>
        </div>
        <button class="button button--ghost" data-action="collapse-applied">Back to latest</button>
      </div>
    `
  }

  if (item.state === 'dismissed') {
    return `
      <div class="card card--dismissed">
        <div class="item-head"><span class="actor actor--quiet">${icons.blocked} AI suggestion dismissed</span><span class="time">${item.time}</span></div>
        ${button('Undo', 'button--ghost', 'undo-dismiss')}
      </div>
    `
  }

  if (item.state === 'replying' || item.state === 'thread') {
    const extra = item.state === 'thread'
      ? '<div class="thread-bubble thread-bubble--you">Can you suggest a statistic instead?</div><div class="thread-bubble">Global packaging waste is projected to grow to 1.3 billion tons by 2030. - OECD, 2022</div>'
      : ''
    return `
      <div class="card card--ai">
        <div class="thread">
          <div class="thread-bubble">${item.copy}</div>
          ${extra}
        </div>
        <div class="actions-row" style="margin-top:12px">
          ${button('Use', '', 'use-suggestion')}
          ${button('Dismiss', '', 'dismiss-suggestion')}
          ${button('Reply', 'button--ghost', 'reply-suggestion')}
        </div>
      </div>
    `
  }

  return `
    <div class="card card--ai">
      <p class="card-copy">${item.copy}</p>
      <div class="actions-row">
        ${button('Use', 'button--primary', 'use-suggestion', icons.check)}
        ${button('Dismiss', '', 'dismiss-suggestion')}
        ${button('Reply', 'button--ghost', 'reply-suggestion')}
      </div>
    </div>
  `
}

function sourceCard(item) {
  return `
    <div class="source-card">
      <div class="source-icon">${icons.globe}</div>
      <div>
        <div class="source-title">${item.title}</div>
        <div class="source-url">${item.url}</div>
      </div>
      ${icons.chevron}
    </div>
  `
}

function itemBody(item) {
  if (item.type === 'suggestion') return suggestionCard(item)
  if (item.type === 'paraphrase') {
    return `
      <div class="card">
        <div class="diff">
          <div class="diff-line diff-line--old">Consider adding a concrete example to strengthen the claim...</div>
          <div class="diff-line diff-line--new">Consider adding a concrete example to strengthen the claim...</div>
        </div>
        ${button('View diff', 'button--ghost', 'view-diff')}
      </div>
    `
  }
  if (item.type === 'source') return `<p class="card-copy">${item.copy}</p>${sourceCard(item)}`
  if (item.type === 'image') return `<div class="image-thumb" role="img" aria-label="Added image preview"></div><div class="ellipsis">...</div>`
  return `<p class="card-copy">${item.copy}</p>`
}

export function TimelineItem(item) {
  return `
    <article class="timeline-item" data-id="${item.id}">
      ${mark(item)}
      <div class="item-main">
        ${head(item)}
        ${itemBody(item)}
      </div>
    </article>
  `
}

export function ProjectContext() {
  return `
    <section class="context-card">
      <div class="context-label">Assignment title</div>
      <div class="context-row">
        <div class="context-text">Create a proposal that analyzes current packaging waste and recommends practical, scalable solutions....</div>
        ${icons.chevron}
      </div>
    </section>
  `
}

export function Composer() {
  return `
    <form class="composer" data-action="composer">
      <input aria-label="Ask or reply" placeholder="Ask or reply..." />
      <button type="submit" aria-label="Send">${icons.send}</button>
    </form>
  `
}
