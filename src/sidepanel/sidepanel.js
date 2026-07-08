import { complete } from '../lib/ai/ollama-client.js';
import { esc } from '../shared/esc.js';

// ── Utility: Debounce Function ───────────────────────────────────────────────
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

let activeTabId = null;
let _assignmentPrompt = '';
let _docContext = null;
let _lastScanTime = 0;

const _DOC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

function _updateContextIndicator() {
  const el = document.getElementById('doc-context-indicator');
  if (!el) return;
  const words = _docContext?.text?.trim().split(/\s+/).filter(Boolean).length ?? 0;
  if (words > 0) {
    el.innerHTML = `${_DOC_ICON}<span>${words.toLocaleString()} words in context</span>`;
    el.style.color = 'var(--user-color, #5c3ce6)';
  } else {
    el.innerHTML = `${_DOC_ICON}<span>No document context yet</span>`;
    el.style.color = 'var(--text-secondary, #999)';
  }
}

function _updateScanLabel() {
  const label = document.getElementById('last-scan-label');
  if (!label) return;
  if (!_lastScanTime) { label.textContent = 'Not scanned yet'; return; }
  const ageS = Math.round((Date.now() - _lastScanTime) / 1000);
  if (ageS < 10) label.textContent = 'Last scan: just now';
  else if (ageS < 120) label.textContent = `Last scan: ${ageS}s ago`;
  else label.textContent = `Last scan: ${Math.round(ageS / 60)}m ago`;
}

async function _triggerManualScan() {
  const btn = document.getElementById('scan-btn');
  if (btn) { btn.classList.add('scanning'); btn.disabled = true; }
  try {
    const result = await Promise.race([
      chrome.runtime.sendMessage({ action: 'FORCE_SCAN' }),
      new Promise(resolve => setTimeout(() => resolve({ ok: false }), 6000)),
    ]);
    if (result?.ok) {
      _lastScanTime = Date.now();
      _updateScanLabel();
    }
  } catch { /* ignore */ } finally {
    if (btn) { btn.classList.remove('scanning'); btn.disabled = false; }
  }
}

function _cleanAIResponse(text) {
  if (!text) return text;
  let t = text.trim();

  // Unwrap JSON-formatted responses (small models sometimes output {"key": "value"})
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const strVal = Object.values(parsed).find(v => typeof v === 'string' && v.length > 5);
        if (strVal) t = strVal.trim();
      }
    } catch { /* not valid JSON */ }
  }

  // Remove any stray [CURSOR] tokens the model may echo back
  t = t.replace(/\[CURSOR\]/gi, '').trim();

  // Strip meta-commentary prefixes that small models prepend
  const prefixes = [
    /^the user wants me to\b[\s\S]*?\.\s*/i,
    /^i (?:will|should|need to) treat [\s\S]*?\.\s*/i,
    /^\[cursor\]\s*/i,
    /^the user(?:'s)? (?:writing|text) is:\s*/i,
    /^the completed sentence is:\s*/i,
    /^here is (?:the )?(?:paraphras\w*|revis\w*|rewritten) (?:text|version|sentence)?:?\s*/i,
    /^paraphras\w* version:?\s*/i,
    /^revis\w* version:?\s*/i,
    /^here'?s? (?:a |the )?(?:suggestion|revision|paraphrase):?\s*/i,
    /^(?:rewritten|revised|paraphrased):\s*/i,
  ];
  for (const re of prefixes) t = t.replace(re, '');

  // Strip surrounding quotation marks added by the model
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }

  return t;
}

document.addEventListener('DOMContentLoaded', async () => {
  const logoEl = document.getElementById('colophon-logo');
  if (logoEl) logoEl.src = chrome.runtime.getURL('icons/green_doc.svg');

  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

  const closeBtn = document.getElementById('close-panel-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      window.close();
    });
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab.id;

    try {
      await chrome.tabs.sendMessage(activeTabId, { action: 'GET_TITLE' });
    } catch {
      console.warn("Colophon: Content script not ready. (Are you on a Google Doc?)");
    }
  } catch (e) {
    console.error("Could not initialize tab data:", e);
  }

  // Assignment Prompt Editable Logic
  const promptElement = document.getElementById('assignment-brief-text');
  if (promptElement) {
    promptElement.setAttribute('contenteditable', 'true');
    promptElement.style.outline = 'none';
    promptElement.style.cursor = 'text';

    const autoSavePrompt = debounce((newPromptText) => {
      promptElement.style.opacity = '0.6';
      chrome.runtime.sendMessage({
        action: 'UPDATE_METADATA',
        payload: { key: 'assignment_prompt', value: newPromptText }
      }, (response) => {
        promptElement.style.opacity = '1';
        if (chrome.runtime.lastError || response?.status === 'error') {
          promptElement.style.color = "var(--diff-red)";
        } else {
          promptElement.style.color = "var(--text-secondary)";
        }
      });
    }, 800);

    promptElement.addEventListener('input', (e) => {
      _assignmentPrompt = e.target.textContent.trim();
      autoSavePrompt(e.target.textContent);
    });
  }

  // Wire the manual scan button
  const scanBtn = document.getElementById('scan-btn');
  if (scanBtn) scanBtn.addEventListener('click', _triggerManualScan);

  // Export button is temporarily disabled (PDF export coming soon)
  // Refresh the "last scan" label every 30 seconds
  setInterval(_updateScanLabel, 30_000);
  // Seed last scan time and doc context from session metadata if available
  chrome.runtime.sendMessage({ action: 'GET_STATE' }, (res) => {
    const ts = res?.session?.metadata?.last_snapshot_timestamp;
    if (ts) { _lastScanTime = ts; _updateScanLabel(); }
  });
  // Restore doc context from service worker in case sidepanel was re-opened
  chrome.runtime.sendMessage({ action: 'GET_DOC_CONTEXT' }, (res) => {
    if (res?.text) { _docContext = res; _updateContextIndicator(); }
  });

  // Re-seed doc context whenever sidepanel regains visibility (e.g. user switches back)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      chrome.runtime.sendMessage({ action: 'GET_DOC_CONTEXT' }, (res) => {
        if (res?.text) { _docContext = res; _updateContextIndicator(); }
      });
    }
  });

  // Boot the dynamic renderer
  TimelineRenderer.init();
  // Check local AI model status via native host
  ModelStatus.init();
  // Wire the chat input box
  ChatInput.init();
  // Wire highlight-to-AI selection banner
  SelectionContext.init();
  // Init suggestions manager
  SuggestionsManager.init();
  // Init quick actions bar
  QuickActions.init();
  // Wire collapse/dismiss for sticky pane sections
  initCollapsibleSections();
  // Seed scanning dot from initial session state
  chrome.runtime.sendMessage({ action: 'GET_STATE' }, (res) => {
    _updateScanningDot(res?.session?.isRecording ?? false);
  });
});


// ── Collapsible / Dismissible Sections ────────────────────────────────────────
function initCollapsibleSections() {

  // \u2500\u2500 1. Model banner dismiss (\u2715) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  document.getElementById('banner-dismiss-btn')?.addEventListener('click', () => {
    const banner = document.getElementById('model-banner');
    if (!banner) return;
    banner.style.transition = 'opacity 0.2s ease, max-height 0.25s ease';
    banner.style.opacity = '0';
    banner.style.overflow = 'hidden';
    banner.style.maxHeight = banner.scrollHeight + 'px';
    requestAnimationFrame(() => {
      banner.style.maxHeight = '0';
    });
    setTimeout(() => { banner.style.display = 'none'; }, 280);
    sessionStorage.setItem('colophon_banner_dismissed', '1');
  });
  // Re-apply dismissed state if needed (e.g. sidepanel re-opened)
  if (sessionStorage.getItem('colophon_banner_dismissed') === '1') {
    const banner = document.getElementById('model-banner');
    if (banner) banner.style.display = 'none';
  }

  // \u2500\u2500 2. Project context collapse \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const contextSection = document.getElementById('project-context-section');
  const contextBody = document.getElementById('context-body');
  const contextToggle = document.getElementById('assignment-context-toggle');

  if (contextSection && contextBody && contextToggle) {
    const CONTEXT_KEY = 'colophon_context_collapsed';
    const applyContextState = (collapsed, animate = false) => {
      if (!animate) contextBody.style.transition = 'none';
      contextSection.classList.toggle('is-collapsed', collapsed);
      contextBody.classList.toggle('collapsed', collapsed);
      if (!animate) requestAnimationFrame(() => { contextBody.style.transition = ''; });
    };

    // Restore saved state
    applyContextState(sessionStorage.getItem(CONTEXT_KEY) === '1', false);

    contextToggle.addEventListener('click', () => {
      const isNowCollapsed = !contextSection.classList.contains('is-collapsed');
      applyContextState(isNowCollapsed, true);
      sessionStorage.setItem(CONTEXT_KEY, isNowCollapsed ? '1' : '0');
    });
  }

  // \u2500\u2500 3. Review/Suggestions section collapse \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const reviewCollapseBtn = document.getElementById('review-collapse-btn');
  const suggestionsSection = document.getElementById('suggestions-section');

  if (reviewCollapseBtn && suggestionsSection) {
    const REVIEW_KEY = 'colophon_review_collapsed';

    const applyReviewState = (collapsed, animate = false) => {
      if (!animate) suggestionsSection.style.transition = 'none';
      reviewCollapseBtn.classList.toggle('is-collapsed', collapsed);
      suggestionsSection.classList.toggle('collapsed', collapsed);
      if (!animate) requestAnimationFrame(() => { suggestionsSection.style.transition = ''; });
    };

    // Restore saved state — collapsed by default when no preference is
    // stored yet (heuristics are a lighter-weight, secondary feature now).
    applyReviewState(sessionStorage.getItem(REVIEW_KEY) !== '0', false);

    reviewCollapseBtn.addEventListener('click', () => {
      const isNowCollapsed = !reviewCollapseBtn.classList.contains('is-collapsed');
      applyReviewState(isNowCollapsed, true);
      sessionStorage.setItem(REVIEW_KEY, isNowCollapsed ? '1' : '0');
    });
  }
}




// ── Status Header ─────────────────────────────────────────────────────────────
function updateStatusHeader(pendingCount = null) {
  const icon = document.getElementById('status-icon');
  const title = document.getElementById('status-title');
  const subtitle = document.getElementById('status-subtitle');
  if (!icon || !title || !subtitle) return;

  const count = pendingCount ?? SuggestionsManager._queue.length;
  if (count > 0) {
    icon.className = 'status-icon status-warn';
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>';
    title.textContent = `${count} thing${count > 1 ? 's' : ''} to review`;
    subtitle.textContent = 'Check suggestions below.';
  } else {
    icon.className = 'status-icon status-ok';
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
    title.textContent = 'All good';
    subtitle.textContent = "We'll let you know if anything needs attention.";
  }
}

// ── Suggestions Manager ───────────────────────────────────────────────────────
const SuggestionsManager = {
  _queue: [],         // array of { event, key } for unaddressed heuristic suggestions
  _pointer: 0,        // which queue item is shown
  _dismissedKeys: new Set(), // rule::excerpt keys the user explicitly dismissed

  _TAG_MAP: {
    readability:        'Coherence',
    adverb_density:     'Style',
    long_paragraph:     'Structure',
    passive_voice:      'Clarity',
    filler_words:       'Style',
    wordy_phrase:       'Clarity',
    long_sentence:      'Structure',
    repeated_starts:    'Style',
    word_repetition:    'Clarity',
  },

  init() {
    const nextBtn = document.getElementById('next-suggestion-btn');
    if (nextBtn) nextBtn.addEventListener('click', () => {
      this._pointer = (this._pointer + 1) % this._queue.length;
      this._render();
    });

    const dismissAllBtn = document.getElementById('dismiss-all-suggestions-btn');
    if (dismissAllBtn) dismissAllBtn.addEventListener('click', () => this._dismissAll());

    document.getElementById('active-suggestion-card')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-ignore')) this._dismiss();
      if (e.target.classList.contains('btn-apply'))  this._apply();
      if (e.target.classList.contains('btn-preview')) {
        e.preventDefault();
        const preview = document.querySelector('.suggestion-preview-text');
        if (preview) {
          preview.classList.toggle('visible');
          e.target.textContent = preview.classList.contains('visible') ? 'Hide' : 'Preview';
        }
      }
    });
  },

  push(event) {
    // Dedup by (rule, excerpt prefix) — prevents same issue firing every scan
    const key = `${event.meta?.rule}::${(event.meta?.excerpt || '').slice(0, 60)}`;
    if (this._dismissedKeys.has(key)) return;
    if (!this._queue.find(q => q.key === key)) {
      this._queue.push({ event, key });
      this._render();
      updateStatusHeader();
    }
  },

  _dismiss() {
    if (!this._queue.length) return;
    const item = this._queue[this._pointer];
    this._dismissedKeys.add(item.key);
    // Mark dismissed in service worker
    chrome.runtime.sendMessage({
      action: 'UPDATE_EVENT_STATE',
      payload: { eventTimestamp: item.event.timestamp, status: 'dismissed' },
    }).catch(() => {});
    this._queue.splice(this._pointer, 1);
    this._pointer = Math.max(0, Math.min(this._pointer, this._queue.length - 1));
    this._render();
    updateStatusHeader();
  },

  // Clears the whole queue at once, so a backlog of suggestions never has to
  // be worked through one-by-one via "Next" — each is still marked dismissed
  // individually in the service worker, same as a normal single dismiss.
  _dismissAll() {
    if (!this._queue.length) return;
    for (const item of this._queue) {
      this._dismissedKeys.add(item.key);
      chrome.runtime.sendMessage({
        action: 'UPDATE_EVENT_STATE',
        payload: { eventTimestamp: item.event.timestamp, status: 'dismissed' },
      }).catch(() => {});
    }
    this._queue = [];
    this._pointer = 0;
    this._render();
    updateStatusHeader();
  },

  // Jumps the active card to a specific queued suggestion by its event
  // timestamp — used by the "Review" button on a compact timeline card, so
  // clicking it actually shows that suggestion instead of whatever happens
  // to be at the current queue position.
  focusByTimestamp(ts) {
    const idx = this._queue.findIndex(q => q.event.timestamp === ts);
    if (idx === -1) return false;
    this._pointer = idx;
    this._render();
    return true;
  },

  _apply() {
    if (!this._queue.length) return;
    const { event } = this._queue[this._pointer];
    const excerpt = event.meta?.excerpt || '';
    const message = event.meta?.text || '';
    const prompt = excerpt
      ? `Fix this writing issue — ${message}\n\nText: "${excerpt}"`
      : `Improve this text: ${message}`;
    ChatInput._submitText(prompt);
    this._dismiss();
  },

  _render() {
    const section = document.getElementById('suggestions-section');
    const card = document.getElementById('active-suggestion-card');
    const badge = document.getElementById('suggestion-count-badge');
    if (!section || !card) return;

    if (!this._queue.length) {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    if (badge) badge.textContent = this._queue.length;

    const { event } = this._queue[this._pointer] ?? this._queue[0];
    const tag = this._TAG_MAP[event.meta?.rule] ?? 'Writing tip';
    const message = event.meta?.text || '';
    const excerpt = event.meta?.excerpt || '';

    card.innerHTML = `
      <div class="suggestion-card-new">
        <span class="suggestion-tag">${tag}</span>
        <p>${esc(message)}</p>
        ${excerpt ? `<div class="suggestion-context">&ldquo;${esc(excerpt.slice(0, 100))}&rdquo;</div>` : ''}
        ${excerpt ? `<div class="suggestion-preview-text">${esc(excerpt)}</div>` : ''}
        <div class="suggestion-actions">
          ${excerpt ? `<a href="#" class="btn-preview">Preview</a>` : ''}
          <button class="btn-apply">Apply</button>
          <button class="btn-ignore">Ignore</button>
        </div>
      </div>
    `;
  },
};

// ── Dynamic Timeline Renderer & State Manager ─────────────────────────────
const TimelineRenderer = {
  container: document.getElementById('timeline-container'),
  renderedTimestamps: new Set(),
  sessionStartTime: null,
  // Tracks grouped edit cards: key=groupKey, value=domNode
  _editGroups: new Map(),

  init() {
    // "See all" opens the viewer page in a new tab with live session data
    document.getElementById('see-all-events-btn')?.addEventListener('click', () => {
      const viewerUrl = chrome.runtime.getURL('viewer/viewer.html') + '?live=1';
      chrome.tabs.create({ url: viewerUrl });
    });

    chrome.runtime.sendMessage({ action: 'GET_STATE' }, (response) => {
      if (response?.docContext) {
        _docContext = response.docContext;
        _updateContextIndicator();
      }
      if (response?.session?.events) {
        this.render(response.session.events);
      }
      if (response?.session?.metadata?.assignment_prompt) {
        _assignmentPrompt = response.session.metadata.assignment_prompt;
        const brief = document.getElementById('assignment-brief-text');
        if (brief) brief.textContent = _assignmentPrompt;
      }
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'SYNC_TIMELINE') {
        this.render(msg.events);
        // Keep scanning dot in sync with recording state
        chrome.runtime.sendMessage({ action: 'GET_STATE' }, (res) => {
          _updateScanningDot(res?.session?.isRecording ?? false);
        });
      }
      if (msg.action === 'AUTO_EXPORT_LIGHTENED') {
        _showAutoExportNotice();
      }
      if (msg.action === 'DOC_CONTEXT_UPDATE') {
        _docContext = { text: msg.text, cursorIndex: msg.cursorIndex, selectedText: msg.selectedText };
        if (msg.lastSnapshotTime) { _lastScanTime = msg.lastSnapshotTime; _updateScanLabel(); }
        _updateContextIndicator();
      }
      if (msg.action === 'CONTEXT_MENU_ACTION') {
        const { menuId, text } = msg.payload ?? {};
        if (!text) return;
        if (menuId === 'colophon-paraphrase') {
          // Submit a paraphrase request directly via ChatInput, pre-seeding the selection state
          SelectionContext._state = { text, context_before: '', context_after: '' };
          ChatInput._submitText(`Paraphrase this: "${text.slice(0, 400)}"`);
        } else if (menuId === 'colophon-add-source') {
          SelectionContext._state = { text, context_before: '', context_after: '' };
          // Show a source-attribution prompt in the chat input
          const input = document.querySelector('.input-box input');
          if (input) {
            input.value = `Add source for: "${text.slice(0, 80)}"`;
            input.focus();
          }
        }
      }
    });

    this.attachClickHandlers();
  },

  // Events shown in compact "important" mode (hide noisy individual edits)
  _isImportant(evt) {
    return ['paste', 'ai_interaction', 'heuristic_suggestion', 'ai_suggestion',
            'gemini_suggestion', 'session_start', 'session_end'].includes(evt.type);
  },

  render(events) {
    const sortedEvents = [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const totalEventsCount = events.length;

    // Collect edit events for grouping
    const editRuns = [];
    let currentRun = null;

    sortedEvents.forEach(evt => {
      // Push heuristic suggestions to the SuggestionsManager (idempotent)
      if (evt.type === 'heuristic_suggestion' && evt.meta?.status !== 'dismissed') {
        SuggestionsManager.push(evt);
      }

      if (evt.type === 'edit') {
        if (!currentRun) currentRun = { events: [], totalDelta: 0 };
        currentRun.events.push(evt);
        currentRun.totalDelta += evt.meta?.char_delta ?? 0;
      } else {
        if (currentRun) { editRuns.push(currentRun); currentRun = null; }
      }
    });
    if (currentRun) editRuns.push(currentRun);

    sortedEvents.forEach(evt => {
      if (this.renderedTimestamps.has(evt.timestamp)) {
        this.updateEventState(evt);
        return;
      }

      // Skip individual edit events — shown as grouped card below
      if (evt.type === 'edit') return;

      // In compact mode, heuristic suggestions show as compact cards (also in suggestions section)

      const el = this.buildEventCard(evt, totalEventsCount);
      if (el) {
        this.container.appendChild(el);
        this.renderedTimestamps.add(evt.timestamp);
        this.container.parentElement.scrollTop = this.container.parentElement.scrollHeight;
      }
    });

    // Render grouped edit summary
    {
      editRuns.forEach(run => {
        const groupKey = run.events[0].timestamp;
        if (this._editGroups.has(groupKey)) {
          // Update existing group card
          const node = this._editGroups.get(groupKey);
          const span = node.querySelector('.edit-group-delta');
          if (span) span.textContent = this._formatDelta(run.totalDelta);
          return;
        }
        const last = run.events[run.events.length - 1];
        const el = this._buildEditGroupCard(run.events[0], last, run.totalDelta);
        if (el) {
          // Insert before first non-edit card that comes after this run's start time
          const startTime = new Date(run.events[0].timestamp);
          const allCards = [...this.container.children];
          const insertBefore = allCards.find(c => {
            const ts = c.dataset.timestamp;
            return ts && new Date(ts) > startTime;
          });
          if (insertBefore) this.container.insertBefore(el, insertBefore);
          else this.container.appendChild(el);
          this._editGroups.set(groupKey, el);
        }
      });

      // Show only the last 4 cards in compact mode
      const cards = [...this.container.children];
      const cutoff = Math.max(0, cards.length - 4);
      cards.forEach((c, i) => { c.style.display = i < cutoff ? 'none' : ''; });
    }
  },

  _formatDelta(delta) {
    if (delta > 0) return `+${delta} chars`;
    if (delta < 0) return `${delta} chars`;
    return '0 chars';
  },

  _ruleToLabel(rule) {
    const MAP = {
      passive_voice: 'Clarity issue', readability: 'Readability issue',
      filler_words: 'Style issue', wordy_phrase: 'Style issue',
      long_sentence: 'Clarity issue', repeated_starts: 'Flow issue',
      word_repetition: 'Coherence issue', long_paragraph: 'Structure issue',
      adverb_density: 'Style issue',
    };
    return MAP[rule] || 'Writing tip';
  },

  _buildEditGroupCard(first, last, totalDelta) {
    const wrapper = document.createElement('div');
    wrapper.className = 'timeline-event-compact';
    wrapper.dataset.timestamp = first.timestamp;
    const timeFrom = this.formatTime(first.timestamp);
    const timeTo = first.timestamp !== last.timestamp ? `–${this.formatTime(last.timestamp)}` : '';
    wrapper.innerHTML = `
      <div class="ecc-icon ecc-user">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      </div>
      <div class="ecc-body">
        <div class="ecc-title">Edited</div>
        <div class="ecc-meta">${timeFrom}${timeTo} · <span class="edit-group-delta">${this._formatDelta(totalDelta)}</span></div>
      </div>
      <div class="ecc-action"></div>
    `;
    return wrapper;
  },

  _buildCompactCard(evt) {
    const time = this.formatTime(evt.timestamp);
    const wrapper = document.createElement('div');
    wrapper.className = 'timeline-event-compact';
    wrapper.dataset.timestamp = evt.timestamp;

    let iconSvg = '', iconClass = 'ecc-user', title = '', meta = '', actionHTML = '';

    if (evt.type === 'paste') {
      const wordCount = Math.round((evt.meta?.char_count ?? 0) / 5);
      iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
      title = 'Pasted content';
      meta = `${time} · ${wordCount > 0 ? wordCount + ' words' : (evt.meta?.char_count ?? 0) + ' chars'}`;
      if (evt.meta?.source !== 'internal') {
        actionHTML = evt.meta?.source_url
          ? `<span class="ecc-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg></span>`
          : `<button class="ecc-btn btn-add-source">Add source</button>`;
      }
    } else if (evt.type === 'ai_interaction') {
      iconClass = 'ecc-ai';
      iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2z"/></svg>`;
      const isParaphrase = evt.meta?.source === 'paraphrase';
      title = evt.meta?.acceptance === 'fully_accepted' ? 'AI suggestion accepted' : 'AI interaction';
      meta = `${time}${isParaphrase ? ' · Paraphrased' : ''}`;
      if (evt.meta?.acceptance === 'fully_accepted') {
        actionHTML = `<span class="ecc-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg></span>`;
      }
    } else if (evt.type === 'heuristic_suggestion') {
      iconClass = 'ecc-warn';
      iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
      title = this._ruleToLabel(evt.meta?.rule);
      const excerpt = evt.meta?.excerpt ? esc(evt.meta.excerpt.slice(0, 32)) + (evt.meta.excerpt.length > 32 ? '…' : '') : '';
      meta = `${time}${excerpt ? ' · ' + excerpt : ''}`;
      actionHTML = evt.meta?.status === 'dismissed'
        ? `<span class="ecc-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg></span>`
        : `<button class="ecc-btn ecc-btn-review" data-ts="${evt.timestamp}">Review</button>`;
    } else if (evt.type === 'gemini_suggestion') {
      iconClass = 'ecc-gemini';
      iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2z"/></svg>`;
      title = 'Gemini insert';
      meta = `${time} · ${evt.meta?.char_count ?? 0} chars`;
    } else if (evt.type === 'session_start') {
      iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
      title = 'Session started';
      meta = time;
    }

    wrapper.innerHTML = `
      <div class="ecc-icon ${iconClass}">${iconSvg}</div>
      <div class="ecc-body">
        <div class="ecc-title">${title}</div>
        <div class="ecc-meta">${meta}</div>
      </div>
      <div class="ecc-action">${actionHTML}</div>
    `;
    return wrapper;
  },

  // ── Event Router ──
  buildEventCard(evt, totalEventsCount) {
    // Use compact icon cards for key event types.
    // ai_interaction that is fully_accepted is excluded here so it gets the
    // full diff card (with before/after blocks and "View diff" toggle) instead.
    const COMPACT_TYPES = ['paste', 'heuristic_suggestion', 'gemini_suggestion', 'session_start'];
    const isCompactAiInteraction = evt.type === 'ai_interaction' && evt.meta?.acceptance !== 'fully_accepted';
    if (COMPACT_TYPES.includes(evt.type) || isCompactAiInteraction) {
      return this._buildCompactCard(evt);
    }

    const timeAgo = this.formatTime(evt.timestamp);
    const wrapper = document.createElement('div');

    wrapper.dataset.timestamp = evt.timestamp;

    let typeClass = 'user';
    let authorLabel = '';
    let contentHTML = '';
    let nodeHTML = `
      <div class="node">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2z"/>
        </svg>
      </div>`;

    if (evt.type === 'session_start') {
      this.sessionStartTime = new Date(evt.timestamp);
      authorLabel = 'You • Session started';

      const durationMs = Date.now() - this.sessionStartTime.getTime();
      const mins = Math.floor(durationMs / 60000);
      const durationStr = mins > 0 ? `${mins}m` : `< 1m`;

      contentHTML = `<div class="text-only">${timeAgo} – Duration: ${durationStr}</div>`;
    }

    else if (evt.type === 'edit') {
      authorLabel = 'You • Edited';
      contentHTML = `<div class="text-only">${evt.meta.char_delta || 0} characters</div>`;
    }

    else if (evt.type === 'paste') {
      authorLabel = 'You • Pasted';
      const sourceLabel = evt.meta.source === 'internal' ? 'within doc' : 'external';
      contentHTML = `<div class="text-only">${evt.meta.char_count || 0} chars from ${sourceLabel}</div>`;
      if (evt.meta.output_preview) {
        contentHTML += `<div class="text-only" style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px;">"${esc(evt.meta.output_preview)}"</div>`;
      }
      if (evt.meta.source !== 'internal') {
        if (evt.meta.source_url && /^https?:\/\//i.test(evt.meta.source_url)) {
          contentHTML += `<div class="paste-source-row"><span class="paste-source-display">Source: <a href="${esc(evt.meta.source_url)}" target="_blank" rel="noopener" style="color:var(--ai-color)">${esc(evt.meta.source_url)}</a></span></div>`;
        } else {
          contentHTML += `<div class="paste-source-row"><button class="btn-add-source" style="background:none;border:1px dashed var(--text-secondary);color:var(--text-secondary);padding:2px 8px;border-radius:4px;font-size:0.75rem;cursor:pointer;margin-top:4px;">+ Add source</button></div>`;
        }
      }
    }

    else if (evt.type === 'heuristic_suggestion') {
      typeClass = 'ai';
      authorLabel = 'Writing tip';
      const tipText = evt.meta.text || '';
      const excerpt = evt.meta.excerpt ? `<div class="text-only" style="font-size:0.8rem;color:var(--text-secondary);margin-top:4px;font-style:italic;">"${esc(evt.meta.excerpt)}"</div>` : '';
      contentHTML = `
        <div class="card suggestion-card">
          <p>${esc(tipText)}</p>
          ${excerpt}
          <div class="actions">
            <button class="btn-dismiss">Dismiss</button>
          </div>
        </div>
      `;
    }

    else if (evt.type === 'ai_suggestion') {
      typeClass = 'ai';
      // Distinguish native Gemini (drives the real Insert button) from local AI
      // (pastes text via the clipboard path).
      const isGemini = evt.meta.model === 'google/gemini';
      authorLabel = isGemini ? 'Gemini • Suggestion' : 'AI • Suggestion';
      const fullText = evt.meta.text || 'No preview available.';
      const isLong = fullText.length > 100;
      const preview = isLong
        ? `${esc(fullText.substring(0, 100))}... <a href="#" class="expand-toggle" style="color: var(--ai-color); font-weight: bold; text-decoration: none; margin-left: 4px;">Show</a>`
        : esc(fullText);

      contentHTML = `
        <div class="card suggestion-card" data-gemini="${isGemini}">
          <p data-full-text="${esc(fullText)}" data-expanded="false">${preview}</p>
          <div class="actions">
            <button class="btn-insert">${isGemini ? 'Accept' : 'Insert'}</button>
            ${!isGemini ? '<button class="btn-copy-ai">Copy</button>' : ''}
            <button class="btn-dismiss">Dismiss</button>
          </div>
        </div>
      `;
    }

    else if (evt.type === 'ai_interaction') {
      const isAccepted = evt.meta.acceptance === 'fully_accepted';

      if (isAccepted) {
        typeClass = 'user-action';
        const isGeminiModel = evt.meta?.model === 'google/gemini';
        authorLabel = isGeminiModel ? 'You • Accepted Gemini' : 'You • Accepted';
        nodeHTML = `<div class="node solid"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></div>`;

        const beforeText = evt.meta.content_before || '';
        const afterText = evt.meta.content_after || '';
        const hasBefore = beforeText.trim().length > 0;
        const hasAfter = afterText.trim().length > 0;

        // Show the "View diff" toggle only when there is both removed and added
        // text to compare. Pure insertions (no replaced content) surface the
        // added block immediately so the user sees what was inserted at a glance.
        const footerHTML = hasBefore
          ? `<a href="#" class="link toggle-diff-btn">View diff</a>`
          : `<span style="font-size:0.75rem;color:var(--text-secondary);">Inserted text</span>`;

        contentHTML = `
          <div class="card diff-card">
            <div class="diff-block removed" style="display: ${hasBefore ? 'none' : 'none'};">
              <div class="indicator"></div>
              <p>${beforeText ? esc(beforeText) : '—'}</p>
            </div>
            <div class="diff-arrow" style="display: none;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg></div>
            <div class="diff-block added">
              <div class="indicator"></div>
              <p>${hasAfter ? esc(afterText) : '(no preview available)'}</p>
            </div>
            <div class="card-footer">
              ${footerHTML}
              <button class="icon-btn small"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
            </div>
          </div>
        `;
      } else {
        typeClass = 'ai';
        authorLabel = 'You • Dismissed';
        const reason = evt.meta.reason || "User dismissed suggestion.";
        contentHTML = `<div class="text-only">${esc(reason)}</div>`;
      }
    }

    else if (evt.type === 'gemini_suggestion') {
      typeClass = 'gemini';
      authorLabel = 'Gemini • AI insert';
      const charCount = evt.meta?.char_count ?? evt.meta?.char_delta ?? 0;
      const velocity = evt.meta?.insertion_velocity;
      const preview = evt.meta?.output_preview || '';
      contentHTML = `
        <div class="card suggestion-card gemini-card">
          <p>${preview ? `"${esc(preview)}"` : `${charCount} characters inserted`}</p>
          ${velocity ? `<div class="text-only" style="font-size:0.75rem;color:var(--text-secondary);">Detected via edit velocity (${velocity} chars/s)</div>` : ''}
        </div>
      `;
    }

    else if (evt.type === 'session_end') {
      typeClass = 'user-action';
      authorLabel = 'Session ended';
      nodeHTML = `<div class="node solid"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><rect x="6" y="6" width="12" height="12" rx="2" ry="2"/></svg></div>`;
      contentHTML = `<div class="text-only"> ${totalEventsCount} events logged</div>`;
    }

    else {
      return null;
    }

    wrapper.className = `timeline-event ${typeClass}`;
    wrapper.innerHTML = `
      ${nodeHTML}
      <div class="event-content">
        <div class="event-header">
          <span class="author">${authorLabel}</span>
          <span class="time">${timeAgo}</span>
        </div>
        ${contentHTML}
      </div>
    `;

    this.updateEventState(evt, wrapper);
    return wrapper;
  },

  updateEventState(evt, domNode = null) {
    const node = domNode || document.querySelector(`.timeline-event[data-timestamp="${evt.timestamp}"]`);
    if (!node || !evt.meta.status) return;

    if (evt.meta.status === 'dismissed') {
      const dismissBtn = node.querySelector('.btn-dismiss');
      const insertBtn = node.querySelector('.btn-insert');
      if (dismissBtn) { dismissBtn.innerHTML = "Dismissed"; dismissBtn.disabled = true; }
      if (insertBtn) insertBtn.disabled = true;
      node.style.opacity = '0.5';
    }
    else if (evt.meta.status === 'used') {
      const insertBtn = node.querySelector('.btn-insert');
      const dismissBtn = node.querySelector('.btn-dismiss');
      if (insertBtn) {
        insertBtn.innerHTML = "Inserted ✓";
        insertBtn.style.backgroundColor = "var(--user-color)";
        insertBtn.style.color = "white";
        insertBtn.style.borderColor = "var(--user-color)";
        insertBtn.disabled = true;
      }
      if (dismissBtn) dismissBtn.disabled = true;
    }
  },

  formatTime(isoString) {
    return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  },

  // ── Interactive Event Delegation ──────────────────────────────────────────
  attachClickHandlers() {
    this.container.addEventListener('click', async (e) => {

      // ── ADD SOURCE (paste attribution) ──
      if (e.target.classList.contains('btn-add-source')) {
        const btn = e.target;
        const row = btn.parentElement;
        const eventCard = btn.closest('.timeline-event') || btn.closest('.timeline-event-compact');
        const cardTimestamp = eventCard?.dataset.timestamp;

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'URL or source label…';
        input.style.cssText = 'font-size:0.8rem;padding:2px 6px;border:1px solid var(--ai-color);border-radius:4px;outline:none;width:160px;';

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.style.cssText = 'font-size:0.75rem;padding:2px 8px;margin-left:4px;background:var(--ai-color);color:white;border:none;border-radius:4px;cursor:pointer;';

        row.replaceChildren(input, saveBtn);
        input.focus();

        const save = () => {
          const val = input.value.trim();
          if (!val) { row.replaceChildren(btn); return; }
          const displayHref = /^https?:\/\//i.test(val)
            ? `<a href="${esc(val)}" target="_blank" rel="noopener" style="color:var(--ai-color)">${esc(val)}</a>`
            : esc(val);
          row.innerHTML = `<span class="paste-source-display" style="font-size:0.8rem;color:var(--text-secondary);">Source: ${displayHref}</span>`;
          if (cardTimestamp) {
            chrome.runtime.sendMessage({
              action: 'UPDATE_EVENT_METADATA',
              payload: { eventTimestamp: cardTimestamp, key: 'source_url', value: val },
            }).catch(() => {});
          }
        };

        saveBtn.addEventListener('click', save);
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') row.replaceChildren(btn); });
        return;
      }

      // Review button on compact heuristic suggestion cards
      if (e.target.classList.contains('ecc-btn-review')) {
        const section = document.getElementById('suggestions-section');
        SuggestionsManager.focusByTimestamp(e.target.dataset.ts);
        if (section) {
          section.hidden = false;
          section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        return;
      }

      // View Diff Toggle
      if (e.target.classList.contains('toggle-diff-btn')) {
        e.preventDefault();
        const card = e.target.closest('.diff-card');
        const removedBlock = card.querySelector('.diff-block.removed');
        const arrowBlock = card.querySelector('.diff-arrow');

        if (removedBlock.style.display === 'none') {
          removedBlock.style.display = 'flex';
          arrowBlock.style.display = 'flex';
          e.target.textContent = 'Hide diff';
        } else {
          removedBlock.style.display = 'none';
          arrowBlock.style.display = 'none';
          e.target.textContent = 'View diff';
        }
        return;
      }

      // Expand/Collapse Toggle
      if (e.target.classList.contains('expand-toggle')) {
        e.preventDefault();
        const p = e.target.closest('p');
        if (p.dataset.expanded === "true") {
          p.innerHTML = `${esc(p.dataset.fullText.substring(0, 100))}... <a href="#" class="expand-toggle" style="color: var(--ai-color); font-weight: bold; text-decoration: none; margin-left: 4px;">Show</a>`;
          p.dataset.expanded = "false";
        } else {
          p.innerHTML = `${esc(p.dataset.fullText)} <a href="#" class="expand-toggle" style="color: var(--text-secondary); font-weight: bold; text-decoration: none; margin-left: 4px;">Hide</a>`;
          p.dataset.expanded = "true";
        }
        return;
      }

      // ── DISMISS BUTTON LOGIC ──
      const dismissBtn = e.target.closest('.btn-dismiss');
      if (dismissBtn) {
        const eventCard = dismissBtn.closest('.timeline-event');
        const cardTimestamp = eventCard.dataset.timestamp;
        const p = eventCard.querySelector('p');
        const textPreview = p.dataset.fullText ? p.dataset.fullText : p.textContent;
        const isGemini = eventCard.querySelector('[data-gemini="true"]') !== null;

        TimelineRenderer.updateEventState({ timestamp: cardTimestamp, meta: { status: 'dismissed' } });
        chrome.runtime.sendMessage({
          action: 'UPDATE_EVENT_STATE',
          payload: { eventTimestamp: cardTimestamp, status: 'dismissed' }
        }).catch(() => {});

        if (isGemini) {
          // Click the real Close button — the detector's onResolve will fire and
          // log the rejected ai_interaction event. No second LOG_EVENT here.
          if (activeTabId) {
            chrome.tabs.sendMessage(activeTabId, { action: 'GEMINI_REJECT' }).catch(() => {});
          }
        } else {
          // Local AI suggestions have no detector, so log the rejection here.
          chrome.runtime.sendMessage({
            action: 'LOG_EVENT',
            payload: {
              type: 'ai_interaction',
              timestamp: new Date().toISOString(),
              meta: {
                model: 'local/unknown',
                output_preview: textPreview.substring(0, 100),
                position_start: 0,
                position_end: 0,
                acceptance: 'rejected',
                ai_chars: 0,
                reason: 'User dismissed suggestion.'
              }
            }
          }).catch(() => {});
        }
        return;
      }


      // ── INSERT BUTTON LOGIC ──
      const useBtn = e.target.closest('.btn-insert');
      if (useBtn) {
        const eventCard = useBtn.closest('.timeline-event');
        const cardTimestamp = eventCard.dataset.timestamp;
        const p = eventCard.querySelector('p');
        const isGemini = eventCard.querySelector('[data-gemini="true"]') !== null;

        let textToInsert = p.dataset.fullText || p.textContent;
        textToInsert = textToInsert.replace(/Show$|Hide$/, '').replace(/\.\.\.$/,'').trim();

        useBtn.innerHTML = 'Executing...';
        useBtn.disabled = true;

        const logAcceptance = () => {
          TimelineRenderer.updateEventState({ timestamp: cardTimestamp, meta: { status: 'used' } });
          chrome.runtime.sendMessage({
            action: 'UPDATE_EVENT_STATE',
            payload: { eventTimestamp: cardTimestamp, status: 'used' }
          }).catch(() => {});

          const interactionTimestamp = new Date().toISOString();
          chrome.runtime.sendMessage({
            action: 'LOG_EVENT',
            payload: {
              type: 'ai_interaction',
              timestamp: interactionTimestamp,
              meta: {
                model: isGemini ? 'google/gemini' : 'local/llama-3.2-1b',
                output_preview: textToInsert.substring(0, 100),
                position_start: 0,
                position_end: textToInsert.length,
                acceptance: 'fully_accepted',
                content_before: '[snapshot unavailable]',
                content_after: textToInsert,
                ai_chars: textToInsert.length
              }
            }
          }).catch(() => {});

          if (!isGemini && activeTabId) {
            setTimeout(() => scoreAcceptance(interactionTimestamp, textToInsert, activeTabId), 1500);
          }
        };

        // ── Gemini-native: click the real Insert button in the doc ──
        // NOTE: do NOT call logAcceptance() here. Clicking the real button
        // triggers the Gemini detector's onClickCapture → onResolve → which
        // logs the ai_interaction event with the actual diff from the export
        // API. Calling logAcceptance() here too would create a duplicate card.
        if (isGemini) {
          try {
            const response = await chrome.tabs.sendMessage(activeTabId, { action: 'GEMINI_ACCEPT' });
            if (response?.status === 'ok' || response?.status === 'error') {
              // Just update the card visual — detector handles the event log.
              TimelineRenderer.updateEventState({ timestamp: cardTimestamp, meta: { status: 'used' } });
              chrome.runtime.sendMessage({
                action: 'UPDATE_EVENT_STATE',
                payload: { eventTimestamp: cardTimestamp, status: 'used' },
              }).catch(() => {});
            }
          } catch (err) {
            console.warn('[Colophon] GEMINI_ACCEPT failed:', err);
            useBtn.innerHTML = 'Failed';
            useBtn.style.borderColor = 'var(--diff-red)';
          }
          return;
        }

        // ── Local AI: paste via clipboard ──
        try {
          await navigator.clipboard.writeText(textToInsert);

          try {
            const response = await chrome.tabs.sendMessage(activeTabId, { action: 'APPLY_SUGGESTION', text: textToInsert });
            if (response?.status === 'error') throw new Error('Content script reported an error.');
            logAcceptance();
          } catch (msgErr) {
            const isNoScript = msgErr?.message?.includes('Receiving end') || msgErr?.message?.includes('Could not establish');
            if (isNoScript && activeTabId) {
              // Content script not running (tab not refreshed after extension update) — inject paste inline.
              try {
                await chrome.scripting.executeScript({
                  target: { tabId: activeTabId },
                  func: async (text) => {
                    const frames = [
                      ...document.querySelectorAll('.docs-texteventtarget-iframe'),
                      ...document.querySelectorAll('iframe[aria-hidden="true"]'),
                    ];
                    for (const frame of frames) {
                      const doc = frame.contentDocument || frame.contentWindow?.document;
                      if (!doc) continue;
                      frame.contentWindow.focus();
                      doc.body.focus();
                      await new Promise(r => setTimeout(r, 50));
                      const dt = new DataTransfer();
                      dt.setData('text/plain', text);
                      dt.setData('application/x-colophon-ai', 'true');
                      doc.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
                      return true;
                    }
                    return false;
                  },
                  args: [textToInsert],
                });
                logAcceptance();
              } catch (scriptErr) {
                console.warn('scripting.executeScript fallback failed:', scriptErr);
                useBtn.innerHTML = 'Copied! Press Ctrl+V';
                useBtn.style.backgroundColor = 'var(--text-secondary)';
                useBtn.style.color = 'white';
                logAcceptance();
              }
            } else {
              console.warn('Auto-paste failed or blocked. Falling back to manual paste.', msgErr);
              useBtn.innerHTML = 'Copied! Press Ctrl+V';
              useBtn.style.backgroundColor = 'var(--text-secondary)';
              useBtn.style.color = 'white';
              logAcceptance();
            }
          }
        } catch {
          useBtn.innerHTML = 'Failed';
          useBtn.style.borderColor = 'var(--diff-red)';
        }
      }

      // ── COPY BUTTON LOGIC ──
      const copyBtn = e.target.closest('.btn-copy-ai');
      if (copyBtn) {
        const eventCard = copyBtn.closest('.timeline-event');
        const p = eventCard.querySelector('p');
        let text = p.dataset.fullText || p.textContent;
        text = text.replace(/Show$|Hide$/, '').replace(/\.\.\.$/,'').trim();
        try {
          await navigator.clipboard.writeText(text);
          const orig = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          copyBtn.disabled = true;
          setTimeout(() => { copyBtn.textContent = orig; copyBtn.disabled = false; }, 1800);
        } catch {
          copyBtn.textContent = 'Failed';
        }
      }
    });
  }
};

// ── System prompt builder ─────────────────────────────────────────────────────

function _extractLastSentence(text) {
  const segs = text.split(/(?<=[.!?])\s+/);
  return segs.filter(s => s.trim().length > 10).at(-1)?.trim() ?? '';
}

const SNAPSHOT_MAX_AGE_MS = 30_000; // 30 seconds

async function _ensureFreshSnapshot() {
  try {
    const ageRes = await chrome.runtime.sendMessage({ action: 'GET_SNAPSHOT_AGE' });
    const ageMs = ageRes?.ageMs ?? Infinity;
    if (ageMs > SNAPSHOT_MAX_AGE_MS) {
      console.log('[Colophon SP] Snapshot stale (' + Math.round(ageMs / 1000) + 's), forcing rescan…');
      const scanResult = await Promise.race([
        chrome.runtime.sendMessage({ action: 'FORCE_SCAN' }),
        new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 3000)),
      ]);
      if (scanResult?.ok) {
        _lastScanTime = Date.now();
        _updateScanLabel();
      }
    }
  } catch { /* SW or content script unavailable — proceed anyway */ }
}

async function _buildSystemPrompt() {
  const base = 'You are a concise writing assistant embedded in Google Docs. Help the user with their writing. Reply only with the requested text — no explanations, no meta-commentary, no JSON wrappers.';
  const parts = [base];

  if (_assignmentPrompt) parts.push(`Assignment context: ${_assignmentPrompt}`);

  // Ensure the snapshot is fresh before fetching context.
  await _ensureFreshSnapshot();

  // Fetch the freshest snapshot from the service worker.
  // pre_session_snapshot is updated by updateRollingBaseline() on every keydown.
  // _docContext (in-memory) is used only as a fallback if the SW is unavailable.
  let ctx = null;
  try {
    const state = await chrome.runtime.sendMessage({ action: 'GET_STATE' });
    const snap = state?.session?.metadata?.pre_session_snapshot;
    if (snap?.trim().length > 20) ctx = { text: snap, cursorIndex: snap.length };
  } catch { /* SW unavailable */ }
  if (!ctx) ctx = _docContext;

  console.log('[Colophon SP] Context for AI:', ctx ? `${ctx.text?.length} chars` : 'none');
  _updateContextIndicator();

  let before = '';
  if (ctx?.text?.trim().length > 20) {
    const idx = typeof ctx.cursorIndex === 'number' ? ctx.cursorIndex : ctx.text.length;
    before = ctx.text.slice(Math.max(0, idx - 2000), idx).trim();
    const after = ctx.text.slice(idx, idx + 500).trim();

    if (before) parts.push(`Recent writing:\n---\n${before}\n---`);
    if (after)  parts.push(`Upcoming text in document:\n---\n${after}\n---`);
  }

  // Include any active text selection so the AI has a specific target
  const sel = SelectionContext._state;
  if (sel?.text?.length >= 10) {
    parts.push(
      `The user has highlighted this text:\n"${sel.text.slice(0, 600)}"` +
      (sel.context_before ? `\nContext before: "${sel.context_before.slice(-200)}"` : '') +
      (sel.context_after  ? `\nContext after: "${sel.context_after.slice(0, 200)}"` : '')
    );
  } else if (before) {
    // No selection — surface the last sentence so the model has a concrete target
    const lastSentence = _extractLastSentence(before);
    if (lastSentence) parts.push(`Last sentence at cursor:\n"${lastSentence}"`);
  }

  return parts.join('\n\n');
}

// ── Acceptance Similarity Scoring ─────────────────────────────────────────────
function jaccardSimilarity(a, b) {
  const words = s => new Set(s.toLowerCase().match(/\b\w+\b/g) || []);
  const setA = words(a);
  const setB = words(b);
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function acceptanceFromSimilarity(score) {
  if (score >= 0.9) return 'fully_accepted';
  if (score >= 0.5) return 'partially_modified';
  if (score >= 0.1) return 'modified';
  return 'rejected';
}

async function scoreAcceptance(eventTimestamp, suggestionText, tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'GET_EDITOR_TEXT' });
    if (!res?.text) return;
    const score = jaccardSimilarity(suggestionText, res.text);
    const acceptance = acceptanceFromSimilarity(score);

    // Locate suggestion in doc and extract surrounding context
    let content_before = '';
    let content_after = '';
    const searchKey = suggestionText.slice(0, 50);
    const idx = res.text.indexOf(searchKey);
    if (idx >= 0) {
      content_before = res.text.slice(Math.max(0, idx - 300), idx);
      content_after  = res.text.slice(idx + suggestionText.length, idx + suggestionText.length + 300);
    }

    chrome.runtime.sendMessage({
      action: 'UPDATE_EVENT_ACCEPTANCE',
      payload: { eventTimestamp, acceptance, content_before, content_after },
    });
  } catch {
    // Content script not available (not on a Docs page); skip
  }
}

// ── Chat Input Handler ─────────────────────────────────────────────────────────
const ChatInput = {
  // Port stored when ModelStatus receives LAUNCHED
  _endpoint: 'http://127.0.0.1:8080',
  _lastInput: '', // saved for retry

  init() {
    const input = document.querySelector('.input-box input');
    const sendBtn = document.querySelector('.send-btn');
    if (!input || !sendBtn) return;

    const submit = () => this._submit(input, sendBtn);
    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    // Keep endpoint in sync when model launches
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'MODEL_STATUS_UPDATE' && msg.port) {
        this._endpoint = `http://127.0.0.1:${msg.port}`;
      }
    });
  },

  // Programmatic submit (e.g. from context menu action)
  _submitText(text) {
    const input = document.querySelector('.input-box input');
    const sendBtn = document.querySelector('.send-btn');
    if (!input || !sendBtn) return;
    input.value = text;
    this._submit(input, sendBtn);
  },

  async _submit(input, sendBtn) {
    const text = input.value.trim();
    if (!text) return;
    this._lastInput = text;

    input.value = '';
    input.disabled = true;
    sendBtn.disabled = true;

    const pendingTimestamp = new Date().toISOString();
    TimelineRenderer.render([{ type: 'ai_suggestion', timestamp: pendingTimestamp, meta: { text: '…thinking' } }]);

    try {
      const systemPrompt = await _buildSystemPrompt();
      const { text: rawReply, model } = await complete(text, { endpoint: this._endpoint, systemPrompt });
      const reply = _cleanAIResponse(rawReply);

      // If triggered by a quick action (paraphrase/improve), store output so
      // content.js can reclassify the next paste as an AI interaction.
      QuickActions.notifyAIResponse(reply);

      // Replace the placeholder card with the real suggestion
      const existing = document.querySelector(`.timeline-event[data-timestamp="${pendingTimestamp}"]`);
      if (existing) existing.remove();
      TimelineRenderer.renderedTimestamps.delete(pendingTimestamp);

      const now = new Date().toISOString();
      const suggestionEvent = {
        type: 'ai_suggestion',
        timestamp: now,
        meta: { text: reply, model },
      };

      TimelineRenderer.render([suggestionEvent]);

      // Log to session so it appears in TWFF export
      chrome.runtime.sendMessage({
        action: 'LOG_EVENT',
        payload: {
          type: 'ai_interaction',
          timestamp: now,
          meta: {
            model,
            output_preview: reply.substring(0, 200),
            position_start: 0,
            position_end: 0,
            acceptance: 'pending',
            ai_chars: reply.length,
          },
        },
      });

    } catch (err) {
      const existing = document.querySelector(`.timeline-event[data-timestamp="${pendingTimestamp}"]`);
      if (existing) existing.remove();
      TimelineRenderer.renderedTimestamps.delete(pendingTimestamp);

      const isTimeout = err.name === 'AbortError';
      const isNetworkErr = err instanceof TypeError && (
        err.message.includes('fetch') || err.message.includes('network') || err.message.includes('connect')
      );
      const errMeta = (isTimeout || isNetworkErr)
        ? { title: 'AI not responding', detail: 'Local model is not running. Start it from the model setup panel.' }
        : { title: 'AI error', detail: err.message };

      // Show a dismissable inline error card in the timeline
      const errTs = new Date().toISOString();
      const errCard = document.createElement('div');
      errCard.className = 'timeline-event-compact ecc-error-card';
      errCard.dataset.timestamp = errTs;
      errCard.innerHTML = `
        <div class="ecc-icon ecc-warn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="ecc-body">
          <div class="ecc-title">${esc(errMeta.title)}</div>
          <div class="ecc-meta">${esc(errMeta.detail)}</div>
        </div>
        <div class="ecc-action" style="gap:4px;display:flex;">
          ${(isTimeout || isNetworkErr) ? '<button class="ecc-btn ecc-btn-retry-ai">Retry</button>' : ''}
          <button class="ecc-btn-close-err" title="Dismiss" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:2px 4px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="width:14px;height:14px;"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        </div>
      `;
      errCard.querySelector('.ecc-btn-close-err')?.addEventListener('click', () => errCard.remove());
      errCard.querySelector('.ecc-btn-retry-ai')?.addEventListener('click', () => {
        errCard.remove();
        if (this._lastInput) this._submitText(this._lastInput);
      });
      TimelineRenderer.container.appendChild(errCard);
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    }
  },
};

// ── Local AI Model Status Manager ─────────────────────────────────────────────
const ModelStatus = {
  statusEl: null,
  bannerEl: null,

  init() {
    this.statusEl = document.getElementById('model-status-display');
    this.bannerEl = document.getElementById('model-banner');

    // Ask service worker to ping the native host
    chrome.runtime.sendMessage({ action: 'CHECK_MODEL_STATUS' }, (res) => {
      if (chrome.runtime.lastError) {
        this._update('host_not_installed');
        return;
      }
      // Status may already be known if SW was already running
      if (res?.status && res.status !== 'unknown') {
        this._update(res.status, res);
      }
    });

    // Listen for async status updates (native host responds asynchronously)
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'MODEL_STATUS_UPDATE') this._update(msg.status, msg);
      if (msg.action === 'MODEL_DOWNLOAD_PROGRESS') this._onProgress(msg.label, msg.percent);
      if (msg.action === 'MODEL_ERROR') this._onError(msg.message);
    });
  },

  _update(status, data = {}) {
    switch (status) {
      case 'running':
        this._setFooter('connected', 'Local AI ready');
        this._hideBanner();
        if (data.port) {
          ChatInput._endpoint = `http://127.0.0.1:${data.port}`;
          console.log('[Colophon] Local AI endpoint set to:', ChatInput._endpoint);
        }
        break;
      case 'available':
        this._setFooter('available', 'Model ready');
        this._showBanner('launch');
        break;
      case 'no_model':
        this._setFooter('disconnected', 'No model');
        this._showBanner('download');
        break;
      case 'host_not_installed':
      case 'disconnected':
      default:
        this._setFooter('disconnected', 'AI setup needed');
        this._showBanner('setup');
        break;
    }
  },

  _setFooter(dotClass, label) {
    if (this.statusEl) {
      this.statusEl.innerHTML = `<span class="dot ${dotClass}"></span> ${label}`;
    }
  },

  _showBanner(type) {
    if (!this.bannerEl) return;
    this.bannerEl.className = `model-banner ${type}`;
    this.bannerEl.style.display = 'flex';

    const configs = {
      setup: {
        text: 'Local AI needs one-time setup.',
        actionLabel: 'Download setup file',
        actionFn: () => this._downloadSetup(),
      },
      setup_downloaded: {
        text: 'Run the downloaded file, then:',
        actionLabel: 'Check again',
        actionFn: () => chrome.runtime.sendMessage({ action: 'CHECK_MODEL_STATUS' }).catch(() => {}),
      },
      download: {
        text: 'No local model found.',
        actionLabel: 'Download ~720 MB',
        actionFn: () => this._startDownload(),
      },
      launch: {
        text: 'Model downloaded.',
        actionLabel: 'Start AI',
        actionFn: (e) => {
          const btn = e.target;
          if (btn) {
            btn.textContent = 'Starting AI...';
            btn.disabled = true;
            btn.style.opacity = '0.7';
            btn.style.cursor = 'not-allowed';
          }
          chrome.runtime.sendMessage({ action: 'REQUEST_LAUNCH_MODEL' }).catch(() => {});
        },
      },
    };

    const c = configs[type] || configs.setup;
    this.bannerEl.innerHTML = `
      <span class="banner-text">${c.text}</span>
      <button class="banner-btn">${c.actionLabel}</button>
    `;
    this.bannerEl.querySelector('.banner-btn').addEventListener('click', c.actionFn);
  },

  async _downloadSetup() {
    if (!this.bannerEl) return;
    this.bannerEl.innerHTML = `<span class="banner-text">Preparing setup file…</span>`;

    let result;
    try {
      result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'REQUEST_SETUP_SCRIPT' }, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        });
      });
    } catch (e) {
      this._onError(`Could not generate setup script: ${e.message}`);
      return;
    }

    if (!result?.ok) {
      this._onError(result?.error || 'Setup script generation failed.');
      return;
    }

    const blob = new Blob([result.script], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: result.filename, saveAs: false }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });

    // Show "run the file, then check again" state
    this._showBanner('setup_downloaded');
  },

  _startDownload() {
    if (!this.bannerEl) return;
    this.bannerEl.innerHTML = `
      <span class="banner-text">Downloading… <span id="dl-label">starting</span></span>
      <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
    `;
    chrome.runtime.sendMessage({ action: 'REQUEST_DOWNLOAD_MODEL' }).catch(() => {});
  },

  _onProgress(label, percent) {
    const labelEl = document.getElementById('dl-label');
    if (labelEl) labelEl.textContent = `${label}: ${percent}%`;
    const fill = this.bannerEl?.querySelector('.progress-fill');
    if (fill) fill.style.width = `${percent}%`;
  },

  _onError(message) {
    if (this.bannerEl) {
      // Truncate long messages (e.g. llamafile stderr dumps) to keep banner readable
      const display = esc(message.length > 200 ? message.slice(0, 200) + '…' : message);
      this.bannerEl.style.display = 'flex';
      this.bannerEl.innerHTML = `
        <span class="banner-text error" style="white-space:pre-wrap;font-size:0.75rem;">${display}</span>
        <button class="banner-btn" style="flex-shrink:0;align-self:flex-start;" id="err-retry-btn">Retry</button>
      `;
      this.bannerEl.querySelector('#err-retry-btn')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'CHECK_MODEL_STATUS' }).catch(() => {});
      });
    }
    this._setFooter('disconnected', 'AI error');
  },

  _hideBanner() {
    if (this.bannerEl) this.bannerEl.style.display = 'none';
  },
};

// ── Highlight-to-AI Selection Context ─────────────────────────────────────────
const SelectionContext = {
  el: null,
  _state: { text: '', context_before: '', context_after: '' },

  init() {
    this.el = document.getElementById('selection-banner');

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action !== 'SELECTION_CONTEXT_UPDATE') return;
      if (msg.text && msg.text.length >= 10) {
        this._state = {
          text: msg.text,
          context_before: msg.context_before || '',
          context_after: msg.context_after || '',
        };
        this._show();
      } else {
        this._hide();
      }
    });

    // Catch selections that happened before the sidepanel opened
    chrome.runtime.sendMessage({ action: 'GET_SELECTION' }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.text?.length >= 10) {
        this._state = {
          text: res.text,
          context_before: res.context_before || '',
          context_after: res.context_after || '',
        };
        this._show();
      }
    });
  },

  _show() {
    if (!this.el) return;
    const preview = this._state.text.length > 80
      ? this._state.text.slice(0, 80) + '…'
      : this._state.text;

    this.el.style.display = 'block';
    this.el.innerHTML = `
      <div class="sel-quote">"${esc(preview)}"</div>
      <div class="sel-row">
        <input class="sel-input" placeholder="Ask something about this…" type="text">
        <button class="sel-ask banner-btn">Ask AI</button>
        <button class="sel-dismiss" aria-label="Dismiss"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
      </div>
    `;

    const input = this.el.querySelector('.sel-input');
    const askBtn = this.el.querySelector('.sel-ask');
    const dismissBtn = this.el.querySelector('.sel-dismiss');

    const submit = () => this._submit(input.value.trim());
    askBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    dismissBtn.addEventListener('click', () => this._dismiss());
  },

  _hide() {
    if (!this.el) return;
    this.el.style.display = 'none';
  },

  _dismiss() {
    this._hide();
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { action: 'CLEAR_SELECTION' }).catch(() => {});
    }
  },

  async _submit(question) {
    const { text, context_before, context_after } = this._state;

    const systemPrompt =
      await _buildSystemPrompt() +
      `\n\nThe user has selected this passage:\n"${text.slice(0, 400)}"` +
      (context_before ? `\nContext before: "${context_before.slice(-200)}"` : '') +
      (context_after  ? `\nContext after: "${context_after.slice(0, 200)}"` : '');

    const userMessage = question || `Review this selection and give brief feedback.`;

    const pendingTimestamp = new Date().toISOString();
    TimelineRenderer.render([{ type: 'ai_suggestion', timestamp: pendingTimestamp, meta: { text: '…thinking' } }]);

    const askBtn = this.el?.querySelector('.sel-ask');
    if (askBtn) { askBtn.disabled = true; askBtn.textContent = '…'; }

    try {
      const { text: rawReply, model } = await complete(userMessage, {
        endpoint: ChatInput._endpoint,
        systemPrompt,
      });
      const reply = _cleanAIResponse(rawReply);

      const existing = document.querySelector(`.timeline-event[data-timestamp="${pendingTimestamp}"]`);
      if (existing) existing.remove();
      TimelineRenderer.renderedTimestamps.delete(pendingTimestamp);

      const now = new Date().toISOString();
      TimelineRenderer.render([{ type: 'ai_suggestion', timestamp: now, meta: { text: reply, model } }]);

      chrome.runtime.sendMessage({
        action: 'LOG_EVENT',
        payload: {
          type: 'ai_interaction',
          timestamp: now,
          meta: {
            model,
            output_preview: reply.substring(0, 200),
            position_start: 0,
            position_end: 0,
            acceptance: 'pending',
            ai_chars: reply.length,
            context: text.slice(0, 200),
          },
        },
      });

      if (activeTabId) {
        setTimeout(() => scoreAcceptance(now, reply, activeTabId), 1500);
      }
    } catch (err) {
      const existing = document.querySelector(`.timeline-event[data-timestamp="${pendingTimestamp}"]`);
      if (existing) existing.remove();
      TimelineRenderer.renderedTimestamps.delete(pendingTimestamp);
      const errMsg = err.name === 'AbortError'
        ? 'Request timed out. Is the local AI running?'
        : `AI error: ${err.message}`;
      ModelStatus._onError(errMsg);
    } finally {
      if (askBtn) { askBtn.disabled = false; askBtn.textContent = 'Ask AI'; }
    }
  },
};

// ── Quick Actions Bar ──────────────────────────────────────────────────────────
const QuickActions = {
  _pendingType: null,
  _paraphraseCardOpen: false,
  _grammarCardOpen: false,
  _brainstormCardOpen: false,
  _brainstormFormat: 'paragraph',

  init() {
    // Paraphrase
    document.getElementById('qa-paraphrase')?.addEventListener('click', () => this._openParaphraseCard());
    document.getElementById('btn-paraphrase-dismiss')?.addEventListener('click', () => this._closeParaphraseCard());
    document.getElementById('btn-paraphrase-submit')?.addEventListener('click', () => this._submitParaphrase());
    document.getElementById('paraphrase-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this._submitParaphrase();
    });

    // Grammar
    document.getElementById('qa-grammar')?.addEventListener('click', () => this._openGrammarCard());
    document.getElementById('btn-grammar-dismiss')?.addEventListener('click', () => this._closeGrammarCard());
    document.getElementById('btn-grammar-submit')?.addEventListener('click', () => this._submitGrammar());
    document.getElementById('grammar-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this._submitGrammar();
    });

    // Brainstorm
    document.getElementById('qa-brainstorm')?.addEventListener('click', () => this._openBrainstormCard());
    document.getElementById('btn-brainstorm-dismiss')?.addEventListener('click', () => this._closeBrainstormCard());
    document.getElementById('btn-brainstorm-submit')?.addEventListener('click', () => this._submitBrainstorm());
    document.getElementById('brainstorm-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this._submitBrainstorm();
    });
    document.querySelectorAll('.fmt-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._brainstormFormat = btn.dataset.fmt;
      });
    });
  },

  _getSelectedText() {
    return _docContext?.selectedText?.trim() || SelectionContext._state?.text?.trim() || '';
  },

  _closeAllCards() {
    this._closeParaphraseCard();
    this._closeGrammarCard();
    this._closeBrainstormCard();
  },

  // ── Paraphrase ──
  _openParaphraseCard() {
    if (this._paraphraseCardOpen) { document.getElementById('paraphrase-input')?.focus(); return; }
    this._closeAllCards();
    const card = document.getElementById('paraphrase-card');
    if (!card) return;
    this._paraphraseCardOpen = true;
    card.hidden = false;
    const ta = document.getElementById('paraphrase-input');
    if (ta) { ta.value = this._getSelectedText(); ta.focus(); }
  },

  _closeParaphraseCard() {
    const card = document.getElementById('paraphrase-card');
    if (card) card.hidden = true;
    const ta = document.getElementById('paraphrase-input');
    if (ta) ta.value = '';
    this._paraphraseCardOpen = false;
  },

  _submitParaphrase() {
    const text = document.getElementById('paraphrase-input')?.value?.trim();
    if (!text) return;
    this._pendingType = 'paraphrase';
    ChatInput._submitText(`Paraphrase this, keeping the same meaning:\n\n${text}`);
    this._closeParaphraseCard();
  },

  // ── Grammar ──
  _openGrammarCard() {
    if (this._grammarCardOpen) { document.getElementById('grammar-input')?.focus(); return; }
    this._closeAllCards();
    const card = document.getElementById('grammar-card');
    if (!card) return;
    this._grammarCardOpen = true;
    card.hidden = false;
    const ta = document.getElementById('grammar-input');
    if (ta) { ta.value = this._getSelectedText(); ta.focus(); }
  },

  _closeGrammarCard() {
    const card = document.getElementById('grammar-card');
    if (card) card.hidden = true;
    const ta = document.getElementById('grammar-input');
    if (ta) ta.value = '';
    this._grammarCardOpen = false;
  },

  _submitGrammar() {
    const text = document.getElementById('grammar-input')?.value?.trim();
    if (!text) return;
    this._pendingType = 'grammar';
    ChatInput._submitText(`Fix any grammar and style issues in this text, making only the necessary corrections:\n\n${text}`);
    this._closeGrammarCard();
  },

  // ── Brainstorm ──
  _openBrainstormCard() {
    if (this._brainstormCardOpen) { document.getElementById('brainstorm-input')?.focus(); return; }
    this._closeAllCards();
    const card = document.getElementById('brainstorm-card');
    if (!card) return;
    this._brainstormCardOpen = true;
    card.hidden = false;
    document.getElementById('brainstorm-input')?.focus();
  },

  _closeBrainstormCard() {
    const card = document.getElementById('brainstorm-card');
    if (card) card.hidden = true;
    const ta = document.getElementById('brainstorm-input');
    if (ta) ta.value = '';
    this._brainstormCardOpen = false;
  },

  _submitBrainstorm() {
    const text = document.getElementById('brainstorm-input')?.value?.trim();
    if (!text) return;
    const fmtMap = { paragraph: 'paragraph', sentences: 'short sentences', bullets: 'bullet-point list' };
    const fmt = fmtMap[this._brainstormFormat] || 'paragraph';
    this._pendingType = 'brainstorm';
    ChatInput._submitText(`Organise these ideas into a ${fmt}. Write clearly and concisely:\n\n${text}`);
    this._closeBrainstormCard();
  },

  // Called after an AI response completes — store output so content.js can
  // reclassify the subsequent paste as AI-sourced.
  notifyAIResponse(replyText) {
    if (!this._pendingType) return;
    chrome.runtime.sendMessage({
      action: 'SET_PENDING_AI_OUTPUT',
      payload: { text: replyText },
    }).catch(() => {});
    this._pendingType = null;
  },
};

// ── Footer scanning dot ───────────────────────────────────────────────────────
function _updateScanningDot(isRecording) {
  const dot = document.getElementById('scanning-dot');
  if (dot) dot.classList.toggle('active', !!isRecording);
}

// Shown when a long session auto-exports and lightens itself to stay under
// chrome.storage.local's quota — nothing is deleted (the export is durable),
// only summarized in the live copy, but that shouldn't happen silently.
function _showAutoExportNotice() {
  let el = document.getElementById('auto-export-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'auto-export-notice';
    el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:1000;'
      + 'background:#111827;color:#fff;font-size:0.78rem;padding:10px 14px;'
      + 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.2);transition:opacity 0.3s;';
    document.body.appendChild(el);
  }
  el.textContent = 'Session auto-exported & lightened to keep recording — nothing lost, see Downloads.';
  el.style.opacity = '1';
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 6000);
}

// ── Panel tab switching ───────────────────────────────────────────────────────
document.querySelectorAll('.panel-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.disabled) return;
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.panel;
    const toolsPanel = document.getElementById('panel-tools');
    const chatPanel  = document.getElementById('panel-chat');
    if (toolsPanel) toolsPanel.hidden = (target !== 'tools');
    if (chatPanel)  chatPanel.hidden  = (target !== 'chat');
  });
});
