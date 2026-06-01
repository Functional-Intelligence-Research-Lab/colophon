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
  // pings Ollama to establish connection
  OllamaStatus.init();
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

          chrome.runtime.sendMessage({
            action: 'LOG_EVENT',
            payload: { 
              type: 'ai_interaction', 
              timestamp: new Date().toISOString(),
              meta: { 
                model: "local/unknown", // Hardcoded placeholder for compliance
                output_preview: textToInsert.substring(0, 100), 
                position_start: 0, // Fallback integer
                position_end: textToInsert.length, 
                acceptance: 'fully_accepted', // Standard schema enum
                content_before: "[Original text replaced by paste]", 
                content_after: textToInsert,
                ai_chars: textToInsert.length
              }
            }
          });
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

// ── Ollama Connection Status Manager ──────────────────────────────────────
const OllamaStatus = {
  element: document.querySelector('.app-footer .status'),
  checkInterval: null,

  init() {
    if (!this.element) return;
    this.ping();
    this.checkInterval = setInterval(() => this.ping(), 10000);
  },

  async ping() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch('http://localhost:11434/', {
        method: 'GET',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        this.element.innerHTML = '<span class="dot connected"></span> Local model';
      } else {
        throw new Error('Bad response');
      }

    } catch (err) {
      this.element.innerHTML = '<span class="dot disconnected"></span> ? Disconnected';
    }
  }
};