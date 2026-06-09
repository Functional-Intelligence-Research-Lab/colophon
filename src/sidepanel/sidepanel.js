import { complete } from '../lib/ai/ollama-client.js';

// ── Utility: Debounce Function ───────────────────────────────────────────────
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

let activeTabId = null;

document.addEventListener('DOMContentLoaded', async () => {

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
      const response = await chrome.tabs.sendMessage(activeTabId, { action: 'GET_TITLE' });
      if (response && response.title) {
        document.querySelector('.context-card h3').textContent = response.title;
      }
    } catch (msgErr) {
      console.warn("Colophon: Content script not ready. (Are you on a Google Doc?)");
    }
  } catch (e) {
    console.error("Could not initialize tab data:", e);
  }

  // Assignment Prompt Editable Logic
  const promptElement = document.querySelector('.context-card p');
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

    promptElement.addEventListener('input', (e) => autoSavePrompt(e.target.textContent));
  }

  // Boot the dynamic renderer
  TimelineRenderer.init();
  // Check local AI model status via native host
  ModelStatus.init();
  // Wire the chat input box
  ChatInput.init();
});


// ── Dynamic Timeline Renderer & State Manager ─────────────────────────────
const TimelineRenderer = {
  container: document.getElementById('timeline-container'),
  renderedTimestamps: new Set(), 
  sessionStartTime: null, 

  init() {

    chrome.runtime.sendMessage({ action: 'GET_STATE' }, (response) => {
      if (response?.session?.events) {
        this.render(response.session.events);

        // ── TEMPORARY MOCK DATA FOR TEAM TESTING ──
        if (response.session.events.length === 1 && response.session.events[0].type === 'session_start') {
          const now = Date.now();
          const mockSuggestion = {
            timestamp: new Date(now + 1000).toISOString(), 
            type: "ai_suggestion",
            meta: {
              text: "This paragraph is quite long and might lose the reader's attention. I suggest breaking it into two distinct points: first discussing the environmental impact, and then transitioning into the economic benefits in a new paragraph."
            }
          };

          this.render([mockSuggestion]);

          chrome.runtime.sendMessage({
            action: 'LOG_EVENT',
            payload: mockSuggestion
          });
        }
        // ──────────────────────────────────────────
      }
      if (response?.session?.metadata?.assignment_prompt) {
         document.querySelector('.context-card p').textContent = response.session.metadata.assignment_prompt;
      }
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'SYNC_TIMELINE') {
        this.render(msg.events);
      }
    });

    this.attachClickHandlers();
  },

  render(events) {
    const sortedEvents = [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const totalEventsCount = events.length;

    sortedEvents.forEach(evt => {
      if (!this.renderedTimestamps.has(evt.timestamp)) {
        const el = this.buildEventCard(evt, totalEventsCount);
        if (el) {
          this.container.appendChild(el);
          this.renderedTimestamps.add(evt.timestamp);
          this.container.parentElement.scrollTop = this.container.parentElement.scrollHeight;
        }
      } else {
        this.updateEventState(evt);
      }
    });
  },

  // ── Event Router ──
  buildEventCard(evt, totalEventsCount) {
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
      contentHTML = `<div class="text-only">${evt.meta.char_count || 0} chars from external</div>`;
      if (evt.meta.output_preview) {
         contentHTML += `<div class="text-only" style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px;">"${evt.meta.output_preview}"</div>`;
      }
    }
    
    else if (evt.type === 'ai_suggestion') {
      typeClass = 'ai';
      authorLabel = 'AI • Suggestion';
      const fullText = evt.meta.text || "No preview available.";
      const isLong = fullText.length > 100;
      const preview = isLong ? `${fullText.substring(0, 100)}... <a href="#" class="expand-toggle" style="color: var(--ai-color); font-weight: bold; text-decoration: none; margin-left: 4px;">Show</a>` : fullText;

      contentHTML = `
        <div class="card suggestion-card">
          <p data-full-text="${fullText.replace(/"/g, '&quot;')}" data-expanded="false">${preview}</p>
          <div class="actions">
            <button class="btn-use"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg> Use</button>
            <button class="btn-dismiss">Dismiss</button>
          </div>
        </div>
      `;
    }
    
    else if (evt.type === 'ai_interaction') {
      const isAccepted = evt.meta.acceptance === 'fully_accepted';
      
      if (isAccepted) {
        typeClass = 'user-action';
        authorLabel = 'You • Accepted';
        nodeHTML = `<div class="node solid"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></div>`;
        
        const beforeText = evt.meta.content_before || "...";
        const afterText = evt.meta.content_after || "...";
        
        contentHTML = `
          <div class="card diff-card">
            <div class="diff-block removed" style="display: none;">
              <div class="indicator"></div>
              <p>${beforeText}</p>
            </div>
            <div class="diff-arrow" style="display: none;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg></div>
            <div class="diff-block added">
              <div class="indicator"></div>
              <p>${afterText}</p>
            </div>
            <div class="card-footer">
              <a href="#" class="link toggle-diff-btn">View diff</a>
              <button class="icon-btn small"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
            </div>
          </div>
        `;
      } else {
        typeClass = 'ai'; 
        authorLabel = 'You • Dismissed';
        const reason = evt.meta.reason || "User dismissed suggestion.";
        contentHTML = `<div class="text-only">${reason}</div>`;
      }
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
      const useBtn = node.querySelector('.btn-use');
      if (dismissBtn) { dismissBtn.innerHTML = "Dismissed"; dismissBtn.disabled = true; }
      if (useBtn) useBtn.disabled = true;
      node.style.opacity = '0.5';
    } 
    else if (evt.meta.status === 'used') {
      const useBtn = node.querySelector('.btn-use');
      const dismissBtn = node.querySelector('.btn-dismiss');
      if (useBtn) {
        useBtn.innerHTML = "Inserted ✓";
        useBtn.style.backgroundColor = "var(--user-color)";
        useBtn.style.color = "white";
        useBtn.style.borderColor = "var(--user-color)";
        useBtn.disabled = true;
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
          p.innerHTML = `${p.dataset.fullText.substring(0, 100)}... <a href="#" class="expand-toggle" style="color: var(--ai-color); font-weight: bold; text-decoration: none; margin-left: 4px;">Show</a>`;
          p.dataset.expanded = "false";
        } else {
          p.innerHTML = `${p.dataset.fullText} <a href="#" class="expand-toggle" style="color: var(--text-secondary); font-weight: bold; text-decoration: none; margin-left: 4px;">Hide</a>`;
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
        
        TimelineRenderer.updateEventState({ timestamp: cardTimestamp, meta: { status: 'dismissed' } });
        chrome.runtime.sendMessage({
          action: 'UPDATE_EVENT_STATE',
          payload: { eventTimestamp: cardTimestamp, status: 'dismissed' } 
        });

        chrome.runtime.sendMessage({
          action: 'LOG_EVENT',
          payload: { 
            type: 'ai_interaction', 
            timestamp: new Date().toISOString(),
            meta: { 
              model: "local/unknown", // Hardcoded placeholder for compliance
              output_preview: textPreview.substring(0, 100), 
              position_start: 0, // Fallback integer
              position_end: 0, // Fallback integer
              acceptance: 'rejected', // Standard schema enum
              ai_chars: 0, 
              reason: 'User dismissed suggestion.'
            }
          }
        });
        return; 
      }

      // ── USE BUTTON LOGIC ──
      const useBtn = e.target.closest('.btn-use');
      if (useBtn) {
        const eventCard = useBtn.closest('.timeline-event');
        const cardTimestamp = eventCard.dataset.timestamp; 
        const p = eventCard.querySelector('p');
        
        let textToInsert = p.dataset.fullText || p.textContent;
        textToInsert = textToInsert.replace(/Show$|Hide$/, '').replace(/\.\.\.$/, '').trim();

        useBtn.innerHTML = "Executing...";
        useBtn.disabled = true;

        const logAcceptance = () => {
          TimelineRenderer.updateEventState({ timestamp: cardTimestamp, meta: { status: 'used' } });
          chrome.runtime.sendMessage({
            action: 'UPDATE_EVENT_STATE',
            payload: { eventTimestamp: cardTimestamp, status: 'used' }
          });

          const interactionTimestamp = new Date().toISOString();
          chrome.runtime.sendMessage({
            action: 'LOG_EVENT',
            payload: {
              type: 'ai_interaction',
              timestamp: interactionTimestamp,
              meta: {
                model: "local/llama-3.2-1b",
                output_preview: textToInsert.substring(0, 100),
                position_start: 0,
                position_end: textToInsert.length,
                acceptance: 'fully_accepted', // refined by similarity check below
                content_before: "[snapshot unavailable]",
                content_after: textToInsert,
                ai_chars: textToInsert.length
              }
            }
          });

          // Refine acceptance after the document has a moment to update
          if (activeTabId) {
            setTimeout(() => scoreAcceptance(interactionTimestamp, textToInsert, activeTabId), 1500);
          }
        };

        try {
          await navigator.clipboard.writeText(textToInsert);

          try {
            const response = await chrome.tabs.sendMessage(activeTabId, { action: 'APPLY_SUGGESTION', text: textToInsert });
            if (response?.status === "error") throw new Error("Content script reported an error.");
            
            logAcceptance();

          } catch (msgErr) {
            // Auto-paste failed! Fall back, but STILL log the interaction
            console.warn("Auto-paste failed or blocked. Falling back to manual paste.", msgErr);
            useBtn.innerHTML = "Copied! Press Ctrl+V";
            useBtn.style.backgroundColor = "var(--text-secondary)";
            useBtn.style.color = "white";
            
            logAcceptance(); 
          }
        } catch (err) {
          useBtn.innerHTML = "Failed";
          useBtn.style.borderColor = "var(--diff-red)";
        }
      }
    });
  }
};

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

  async _submit(input, sendBtn) {
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    input.disabled = true;
    sendBtn.disabled = true;

    // Log the pending ai_interaction event immediately so it appears in the timeline
    const pendingTimestamp = new Date().toISOString();
    const pendingEvent = {
      type: 'ai_suggestion',
      timestamp: pendingTimestamp,
      meta: { text: '…thinking' },
    };
    TimelineRenderer.render([pendingEvent]);

    try {
      const { text: reply, model } = await complete(text, { endpoint: this._endpoint });

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

      const errMsg = err.name === 'AbortError'
        ? 'Request timed out. Is the local AI running?'
        : `AI error: ${err.message}`;

      // Show error as a brief banner flash
      ModelStatus._onError(errMsg);
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    }
  },
};

// ── Local AI Model Status Manager ─────────────────────────────────────────────
const ModelStatus = {
  statusEl: document.querySelector('.app-footer .status'),
  bannerEl: null,

  init() {
    this.bannerEl = document.getElementById('model-banner');

    // Ask service worker to ping the native host
    chrome.runtime.sendMessage({ action: 'CHECK_MODEL_STATUS' }, (res) => {
      if (chrome.runtime.lastError) {
        this._update('host_not_installed');
        return;
      }
      // Status may already be known if SW was already running
      if (res?.status && res.status !== 'unknown') {
        this._update(res.status);
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
        actionFn: () => chrome.runtime.sendMessage({ action: 'CHECK_MODEL_STATUS' }),
      },
      download: {
        text: 'No local model found.',
        actionLabel: 'Download ~720 MB',
        actionFn: () => this._startDownload(),
      },
      launch: {
        text: 'Model downloaded.',
        actionLabel: 'Start AI',
        actionFn: () => chrome.runtime.sendMessage({ action: 'REQUEST_LAUNCH_MODEL' }),
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
    chrome.runtime.sendMessage({ action: 'REQUEST_DOWNLOAD_MODEL' });
  },

  _onProgress(label, percent) {
    const labelEl = document.getElementById('dl-label');
    if (labelEl) labelEl.textContent = `${label}: ${percent}%`;
    const fill = this.bannerEl?.querySelector('.progress-fill');
    if (fill) fill.style.width = `${percent}%`;
  },

  _onError(message) {
    if (this.bannerEl) {
      this.bannerEl.innerHTML = `<span class="banner-text error">Error: ${message}</span>`;
    }
    this._setFooter('disconnected', 'AI error');
  },

  _hideBanner() {
    if (this.bannerEl) this.bannerEl.style.display = 'none';
  },
};