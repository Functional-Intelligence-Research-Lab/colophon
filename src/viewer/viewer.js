import JSZip from '../lib/jszip.js';

// ── File input / drag-drop ────────────────────────────────────────────────────

const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const viewerContent = document.getElementById('viewer-content');
const errorBanner   = document.getElementById('error-banner');
const pdfBtn        = document.getElementById('btn-annotated-pdf');

let _liveInterval = null;

fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) loadFile(file);
  fileInput.value = '';
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) dropZone.classList.remove('drag-over');
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

// ── Live session mode ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const isLive = new URL(location.href).searchParams.get('live') === '1';
  if (!isLive) return;

  if (pdfBtn) {
    pdfBtn.disabled = true;
    pdfBtn.title = 'Export a .twff file first to generate an annotated PDF';
  }

  loadLiveSession();
  _liveInterval = setInterval(loadLiveSession, 3000);
});

async function loadLiveSession() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    const session = state?.session;
    if (!session) {
      // No active session — show drop zone with a hint
      viewerContent.hidden = true;
      dropZone.hidden = false;
      const sub = dropZone.querySelector('.drop-sub');
      if (sub) sub.innerHTML = 'No active session — start recording in Google Docs, or drag a <strong>.twff</strong> file here';
      if (!session?.isRecording && _liveInterval) {
        clearInterval(_liveInterval);
        _liveInterval = null;
      }
      return;
    }

    const meta = { title: session.metadata?.docTitle || 'Live Session' };
    renderSession(session, meta, '');

    if (!session.isRecording && _liveInterval) {
      clearInterval(_liveInterval);
      _liveInterval = null;
    }
  } catch {
    // Service worker may be asleep — next poll will retry
  }
}

// ── Load + parse .twff ────────────────────────────────────────────────────────

async function loadFile(file) {
  hideError();
  try {
    const zip  = await JSZip.loadAsync(file);

    const logEntry = zip.file('meta/process-log.json');
    if (!logEntry) throw new Error('Not a valid .twff file (missing meta/process-log.json)');

    const log  = JSON.parse(await logEntry.async('string'));
    const metaEntry  = zip.file('meta/metadata.json');
    const meta       = metaEntry ? JSON.parse(await metaEntry.async('string')) : {};
    const xhtmlEntry = zip.file('content/document.xhtml');
    const xhtmlStr   = xhtmlEntry ? await xhtmlEntry.async('string') : '';

    renderSession(log, meta, xhtmlStr);
  } catch (err) {
    showError(`Could not read file: ${err.message}`);
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderSession(log, meta, xhtmlStr = '') {
  try {
    _renderSessionInner(log, meta, xhtmlStr);
  } catch (err) {
    showError(`Render error: ${err.message}`);
  }
}

function _renderSessionInner(log, meta, xhtmlStr) {
  const events = log.events ?? [];

  // ── Session bar ──
  const startEvt = events.find(e => e.type === 'session_start');
  const endEvt   = events.find(e => e.type === 'session_end');
  const startTs  = startEvt?.timestamp ?? log.startTime ?? null;
  const endTs    = endEvt?.timestamp ?? null;

  const durationMs = startTs && endTs
    ? new Date(endTs) - new Date(startTs)
    : null;

  const lastCheckpoint = [...events].reverse().find(e => e.type === 'checkpoint' && e.meta?.word_count_total);
  const wordCount = lastCheckpoint?.meta?.word_count_total ?? null;
  const charCount = lastCheckpoint?.meta?.char_count_total ?? null;

  const docTitle = meta.title || log.title || 'Untitled document';

  document.getElementById('session-bar').innerHTML = [
    field('Document', docTitle),
    startTs ? field('Started', fmtDatetime(startTs)) : '',
    durationMs !== null ? field('Duration', fmtDuration(durationMs)) : '',
    wordCount  !== null ? field('Words', wordCount.toLocaleString()) : '',
    charCount  !== null ? field('Characters', charCount.toLocaleString()) : '',
    log.sessionId ? field('Session ID', log.sessionId.slice(0, 8) + '…') : '',
    log.version  ? field('Version', log.version) : '',
  ].filter(Boolean).join('');

  // ── Stats row ──
  const editCount = events.filter(e => e.type === 'edit').length;
  const aiCount   = events.filter(e => e.type === 'ai_interaction').length;
  const pasteCount = events.filter(e => e.type === 'paste').length;
  const accepted  = events.filter(e => e.type === 'ai_interaction' && e.meta?.acceptance === 'fully_accepted').length;
  const acceptRate = aiCount > 0 ? Math.round((accepted / aiCount) * 100) : null;

  document.getElementById('stats-row').innerHTML = [
    statCard('Edits', editCount, 'user'),
    statCard('AI Interactions', aiCount, 'ai'),
    acceptRate !== null ? statCard('Acceptance', acceptRate + '%', 'ai') : '',
    statCard('Pastes', pasteCount, ''),
    statCard('Total Events', events.length, ''),
  ].filter(Boolean).join('');

  // ── Annotated PDF button (in header) ──
  if (pdfBtn && xhtmlStr) {
    pdfBtn.disabled = false;
    pdfBtn.title = '';
    pdfBtn.onclick = () => openAnnotatedView(log, meta, xhtmlStr);
  }

  // ── Timeline ──
  const sorted = [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const tlContainer = document.getElementById('timeline');
  tlContainer.innerHTML = sorted.map(buildCard).filter(Boolean).join('');

  // Show viewer, hide drop zone
  dropZone.hidden = true;
  viewerContent.hidden = false;
}

// ── Event card builder ────────────────────────────────────────────────────────

function buildCard(evt) {
  const time = fmtTime(evt.timestamp);
  let typeClass = 'user';
  let authorLabel = '';
  let nodeHTML = starNode();
  let bodyHTML = '';

  if (evt.type === 'session_start') {
    authorLabel = 'Session started';
    bodyHTML = `<p class="tl-text">${fmtDatetime(evt.timestamp)}</p>`;
  }
  else if (evt.type === 'session_end') {
    typeClass = 'user-action';
    authorLabel = 'Session ended';
    nodeHTML = solidNode(squareIcon());
    bodyHTML = `<p class="tl-text">Recording complete</p>`;
  }
  else if (evt.type === 'edit') {
    authorLabel = 'You • Edited';
    const delta = evt.meta?.char_delta ?? 0;
    bodyHTML = `<p class="tl-text">${delta > 0 ? '+' : ''}${delta} characters</p>`;
  }
  else if (evt.type === 'paste') {
    authorLabel = 'You • Pasted';
    const chars = evt.meta?.char_count ?? 0;
    bodyHTML = `<p class="tl-text">${chars} chars from external source</p>`;
    if (evt.meta?.output_preview) {
      bodyHTML += `<p class="tl-preview">"${esc(evt.meta.output_preview)}"</p>`;
    }
  }
  else if (evt.type === 'ai_interaction') {
    const acceptance = evt.meta?.acceptance ?? 'pending';
    const accepted = acceptance === 'fully_accepted';
    typeClass = accepted ? 'user-action' : 'ai';
    authorLabel = accepted ? 'You • Accepted AI' : 'AI • Interaction';
    if (accepted) nodeHTML = solidNode(checkIcon());
    const badgeHTML = `<span class="accept-badge ${esc(acceptance)}">${esc(acceptance.replace(/_/g, ' '))}</span>`;
    bodyHTML = `<p class="tl-text">${badgeHTML}</p>`;
    if (evt.meta?.output_preview) {
      bodyHTML += `<p class="tl-preview">"${esc(evt.meta.output_preview)}"</p>`;
    }
  }
  else if (evt.type === 'ai_suggestion') {
    typeClass = 'ai';
    authorLabel = 'AI • Suggestion';
    const preview = evt.meta?.text ? esc(evt.meta.text.slice(0, 120)) + (evt.meta.text.length > 120 ? '…' : '') : '';
    bodyHTML = `<p class="tl-text">${preview}</p>`;
  }
  else if (evt.type === 'gemini_suggestion') {
    typeClass = 'gemini';
    authorLabel = 'Gemini • AI insert';
    const chars = evt.meta?.char_count ?? 0;
    const vel = evt.meta?.insertion_velocity;
    const preview = evt.meta?.output_preview ? esc(evt.meta.output_preview) : `${chars} chars inserted`;
    bodyHTML = `<p class="tl-text">${preview}${vel ? ` <span style="color:#888;font-size:0.85em">(${vel} chars/s)</span>` : ''}</p>`;
  }
  else if (evt.type === 'checkpoint') {
    typeClass = 'user';
    const note = evt.meta?.note ?? 'Checkpoint';
    const wc = evt.meta?.word_count_total;
    authorLabel = `Checkpoint`;
    bodyHTML = `<p class="tl-text">${esc(note)}${wc !== null ? ` — ${wc.toLocaleString()} words` : ''}</p>`;
  }
  else {
    return null;
  }

  return `
    <div class="tl-event ${typeClass}">
      ${nodeHTML}
      <div class="tl-body">
        <div class="tl-header">
          <span class="tl-author">${esc(authorLabel)}</span>
          <span class="tl-time">${time}</span>
        </div>
        ${bodyHTML}
      </div>
    </div>
  `;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function field(label, value) {
  return `<div class="session-field"><span class="label">${label}</span><span class="value">${esc(String(value))}</span></div>`;
}

function statCard(label, value, cls) {
  return `<div class="stat-card ${cls}"><span class="stat-label">${esc(label)}</span><span class="stat-value">${esc(String(value))}</span></div>`;
}

function starNode() {
  return `<div class="tl-node"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2z"/></svg></div>`;
}

function solidNode(svgInner) {
  return `<div class="tl-node solid">${svgInner}</div>`;
}

function checkIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>`;
}

function squareIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDatetime(iso) {
  return new Date(iso).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
}

function hideError() {
  errorBanner.hidden = true;
  errorBanner.textContent = '';
}

// ── Annotated PDF ─────────────────────────────────────────────────────────────

// Fuzzy prefix match
function _fuzzyFind(haystack, needle, expectedLength, consumedRanges, ctxBefore = '', ctxAfter = '') {
  const normN = needle.replace(/\s+/g, ' ').trim();
  const normB = ctxBefore.replace(/\s+/g, ' ').trim();
  const normA = ctxAfter.replace(/\s+/g, ' ').trim();
  
  const beforeCharCount = ctxBefore.replace(/\s+/g, '').length;

  const escapeRe = (str) => str.split(/\s+/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  
  for (const len of [80, 60, 40, 25, 15]) {
    const prefix = normN.slice(0, len);
    if (prefix.length < 10) break;

    // Build the regex for the start boundary
    const startRegexParts = [];
    if (normB) startRegexParts.push(escapeRe(normB));
    startRegexParts.push(escapeRe(prefix));
    const startRegexStr = startRegexParts.join('\\s*');

    try {
      const regex = new RegExp(startRegexStr, 'gi');
      let match;

      while ((match = regex.exec(haystack)) !== null) {
        let currentPos = match.index;
        
        // Advance past the contextBefore characters
        let charsSeen = 0;
        while (currentPos < haystack.length && charsSeen < beforeCharCount) {
          if (!/\s/.test(haystack[currentPos])) charsSeen++;
          currentPos++;
        }
        // Advance past any immediate spaces to hit the exact first char of the text
        while (currentPos < haystack.length && /\s/.test(haystack[currentPos])) {
          currentPos++;
        }

        const startPos = currentPos;
        let endPos = -1;

        if (normA) {
          const afterPrefix = normA.slice(0, 30);
          const endRegex = new RegExp(escapeRe(afterPrefix), 'gi');
          endRegex.lastIndex = startPos; // Start looking forward from the paste start
          const endMatch = endRegex.exec(haystack);

          if (endMatch && endMatch.index <= startPos + (expectedLength * 2) + 1000) {
            endPos = endMatch.index;
          }
        }

        // Fallback: If context_after is empty or deleted, use expectedLength
        if (endPos === -1) {
          const targetLength = expectedLength || needle.length;
          endPos = startPos + targetLength;
          endPos = Math.min(endPos, haystack.length);
        }

        // Trim trailing whitespace from the highlight bounds
        while (endPos > startPos && /\s/.test(haystack[endPos - 1])) {
          endPos--;
        }

        const finalLength = endPos - startPos;

        // Memory check
        const isConsumed = consumedRanges.some(range => 
          startPos < range.end && endPos > range.start
        );

        if (!isConsumed && finalLength > 0) {
          return { pos: startPos, length: finalLength };
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

// Walk all text nodes under root and wrap the first match in a <mark>.
// Returns true if a match was found and wrapped.
function _wrapFirstMatch(docDom, root, needle, annType, label, expectedLength, consumedRanges, ctxBefore, ctxAfter) {
  const walker = docDom.createTreeWalker(root, 0x4 /* NodeFilter.SHOW_TEXT */);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);

  let concat = '';
  const offsets = []; 
  for (const n of nodes) {
    offsets.push(concat.length);
    concat += n.textContent;
  }

  // Pass context to the scout
  const matchData = _fuzzyFind(concat, needle, expectedLength, consumedRanges, ctxBefore, ctxAfter);
  if (!matchData) return false;

  const startPos = matchData.pos;
  const endPos = matchData.pos + matchData.length;
  let wrapped = false;

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const nodeStart = offsets[i];
    const nodeEnd = nodeStart + n.textContent.length;

    if (nodeEnd > startPos && nodeStart < endPos) {
      const localStart = Math.max(0, startPos - nodeStart);
      const localEnd = Math.min(n.textContent.length, endPos - nodeStart);

      const before = n.textContent.slice(0, localStart);
      const matchText = n.textContent.slice(localStart, localEnd);
      const after = n.textContent.slice(localEnd);

      if (matchText) {
        const parent = n.parentNode;
        if (before) parent.insertBefore(docDom.createTextNode(before), n);
        
        const mark = docDom.createElement('mark');
        mark.className = `ann-${annType}`;
        mark.title = label;
        mark.textContent = matchText;
        parent.insertBefore(mark, n);
        
        if (after) parent.insertBefore(docDom.createTextNode(after), n);
        parent.removeChild(n);
        wrapped = true;
      }
    }
  }
  
  // Save spatial coordinates to memory
  if (wrapped) consumedRanges.push({ start: startPos, end: endPos });
  return wrapped;
}

function openAnnotatedView(log, meta, xhtmlStr) {
  const events   = log.events ?? [];
  const docTitle = meta.title || log.title || 'Untitled document';

  let docDom = null;
  let xhtmlStyles = '';
  if (xhtmlStr) {
    try {
      docDom = new DOMParser().parseFromString(xhtmlStr, 'text/html');
       // Extract <style> blocks from XHTML head to preserve Google Docs formatting
      const styleTags = docDom.querySelectorAll('style');
      xhtmlStyles = Array.from(styleTags).map(s => s.textContent).join('\n');
    } catch { docDom = null; }
  }

  // Collect annotations from events
  const annotations = [];
  for (const evt of events) {
    let annType = null, label = null, searchText = null, expectedLength = 0;
    
    // Extract context fields, defaulting to empty strings for backward compatibility
    const ctxBefore = evt.meta?.context_before || '';
    const ctxAfter = evt.meta?.context_after || '';

    if (evt.type === 'ai_interaction') {
      const acc = evt.meta?.acceptance;
      if (acc === 'fully_accepted')          { annType = 'ai-accepted'; label = 'AI accepted'; }
      else if (acc === 'partially_modified') { annType = 'ai-partial';  label = 'AI (partial)'; }
      else continue;
      searchText = evt.meta?.output_preview;
      expectedLength = evt.meta?.ai_chars ?? (searchText ? searchText.length : 0);
    } else if (evt.type === 'gemini_suggestion' && evt.meta?.output_preview) {
      annType = 'gemini'; label = 'Gemini';
      searchText = evt.meta.output_preview;
      expectedLength = evt.meta?.char_count ?? searchText.length;
    } else if (evt.type === 'paste' && evt.meta?.output_preview) {
      annType = 'paste'; label = 'Pasted';
      searchText = evt.meta.output_preview;
      expectedLength = evt.meta?.char_count ?? searchText.length;
    } else { continue; }
    
    if (!searchText || searchText.length < 10) continue;

    // Strip trailing ellipses from truncated previews
    searchText = searchText.replace(/\.{3}$|…$/, '').trim();
    annotations.push({ type: annType, label, text: searchText, expectedLength, ctxBefore, ctxAfter });
  }

  // Inject marks into the parsed DOM
  const unlocated = [];
  const consumedRanges = []; // Initialize the memory array
  
  if (docDom) {
    for (const ann of annotations) {
      // Pass the context and memory down to the wrapper
      const found = _wrapFirstMatch(
        docDom, docDom.body, ann.text, ann.type, ann.label, 
        ann.expectedLength, consumedRanges, ann.ctxBefore, ann.ctxAfter
      );
      if (!found) unlocated.push(ann);
    }
  } else {
    unlocated.push(...annotations);
  }

  const annotatedBodyHTML = docDom
    ? docDom.body.innerHTML
    : '<p style="color:#888">No document content found in this TWFF file.</p>';

  // Session stats for seal
  const startEvt    = events.find(e => e.type === 'session_start');
  const endEvt      = events.find(e => e.type === 'session_end');
  const startTs     = startEvt?.timestamp ?? log.startTime ?? null;
  const endTs       = endEvt?.timestamp ?? null;
  const durationMs  = startTs && endTs ? new Date(endTs) - new Date(startTs) : null;
  const editCount   = events.filter(e => e.type === 'edit').length;
  const aiAccepted  = events.filter(e => e.type === 'ai_interaction' && e.meta?.acceptance === 'fully_accepted').length;
  const aiPartial   = events.filter(e => e.type === 'ai_interaction' && e.meta?.acceptance === 'partially_modified').length;
  const aiDismissed = events.filter(e => e.type === 'ai_interaction' && e.meta?.acceptance === 'rejected').length;
  const pasteCount  = events.filter(e => e.type === 'paste').length;
  const checkpointCount = events.filter(e => e.type === 'checkpoint').length;

  const html = _buildAnnotatedPageHTML({
    docTitle, annotatedBodyHTML, xhtmlStyles, unlocated,
    log, editCount, aiAccepted, aiPartial, aiDismissed, pasteCount, checkpointCount,
    startTs, durationMs,
  });

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

function _buildAnnotatedPageHTML({
  docTitle, annotatedBodyHTML, xhtmlStyles, unlocated,
  log,
  editCount, aiAccepted, aiPartial, aiDismissed, pasteCount, checkpointCount,
  startTs, durationMs,
}) {
  const exportedAt = new Date().toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const startedAt = startTs ? fmtDatetime(startTs) : '—';
  const duration  = durationMs !== null ? fmtDuration(durationMs) : '—';
  const sessionId = log.sessionId ? log.sessionId.slice(0, 8) : '—';

  const driftNote = unlocated.length > 0
    ? `(${unlocated.length} annotation${unlocated.length > 1 ? 's' : ''} could not be located — possible drift, see appendix)`
    : '';

  const unlocatedSection = unlocated.length === 0 ? '' : `
    <div class="page unlocated-page">
      <div class="unlocated-banner">
        <h2 class="unlocated-title">Unlocated annotations (${unlocated.length})</h2>
        <p class="unlocated-note">These could not be matched to the stored document text. This indicates the text was edited after the event was recorded (positional drift).</p>
      </div>
      <ul>
        ${unlocated.map(a => `<li><span class="pill ${esc(a.type)}">${esc(a.label)}</span> <span class="unlocated-text">${esc(a.text.slice(0, 140))}${a.text.length > 140 ? '…' : ''}</span></li>`).join('')}
      </ul>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Annotated Report — ${esc(docTitle)}</title>
<style>
/* ── Original Google Docs styles (preserved from XHTML export) ── */
${xhtmlStyles}

/* ── App UI & Base Setup ── */
* { box-sizing: border-box; margin: 0; padding: 0; }
body { 
  background: #f8f9fa; /* Google Docs gray workspace */
  font-family: Arial, sans-serif; 
  color: #202124;
}

/* ── Sticky Toolbar ── */
.app-header {
  position: sticky; 
  top: 0; 
  z-index: 100; 
  background: #fff; 
  border-bottom: 1px solid #dadce0;
}
.toolbar { 
  padding: 12px 24px; 
  display: flex; 
  align-items: center; 
  gap: 16px; 
}
.toolbar button { 
  padding: 8px 24px; 
  background: #1a73e8; /* Google Material Blue */
  color: #fff; 
  border: none; 
  border-radius: 4px; 
  font-size: 10pt; 
  font-weight: 500;
  cursor: pointer; 
  transition: background 0.2s;
}
.toolbar button:hover { background: #1557b0; }
.toolbar .tip { font-size: 9.5pt; color: #5f6368; }

/* ── Legend ── */
.legend { 
  display: flex; 
  gap: 20px; 
  flex-wrap: wrap; 
  padding: 0 24px 12px; 
}
.legend-item { display: flex; align-items: center; gap: 8px; font-size: 9.5pt; color: #3c4043; }
.legend-item .swatch { width: 14px; height: 14px; border-radius: 3px; display: inline-block; }
.swatch.ai-accepted { background: #ede9ff; border: 1.5px solid #7c3aed; }
.swatch.ai-partial  { background: #ccfbf1; border: 1.5px solid #0d9488; }
.swatch.paste       { background: #fef9c3; border: 1.5px solid #ca8a04; }
.swatch.gemini      { background: #e8f0fe; border: 1.5px solid #1a73e8; }

/* ── Document "Paper" Layout ── */
.workspace {
  padding: 32px 0 64px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 32px;
}
.page {
  background: #fff;
  width: 816px; /* 8.5 inches at 96dpi */
  min-height: 1056px; /* 11 inches at 96dpi */
  padding: 96px; /* 1-inch margins */
  box-shadow: 0 1px 3px 1px rgba(60,64,67,0.15); /* Classic Docs drop shadow */
  font-family: Arial, sans-serif;
  line-height: 1.6;
}
.doc-title-banner { 
  font-size: 18pt; 
  font-weight: 400; 
  color: #000; 
  margin-bottom: 4px;
  border-bottom: 1px solid #dadce0;
  padding-bottom: 12px;
}
.drift-note { 
  font-size: 10pt; 
  color: #b31412; 
  margin-bottom: 24px;
  font-style: italic;
}

/* ── Document Content Formatting ── */
.document-content {
  font-size: 11pt;
  color: #000;
  overflow-wrap: break-word;
}
.document-content img { max-width: 100%; height: auto; }

/* ── Highlighting ── */
mark.ann-ai-accepted { background: #ede9ff; border-bottom: 2px solid #7c3aed; border-radius: 2px; padding: 0 1px; }
mark.ann-ai-partial  { background: #ccfbf1; border-bottom: 2px solid #0d9488; border-radius: 2px; padding: 0 1px; }
mark.ann-paste       { background: #fef9c3; border-bottom: 2px solid #ca8a04; border-radius: 2px; padding: 0 1px; }
mark.ann-gemini      { background: #e8f0fe; border-bottom: 2px solid #1a73e8; border-radius: 2px; padding: 0 1px; }

/* ── Unlocated Page ── */
.unlocated-banner { background: #fefce8; border-left: 4px solid #fde047; padding: 16px 24px; margin-bottom: 24px; }
.unlocated-title { font-size: 12pt; font-weight: 600; color: #854d0e; margin-bottom: 6px; }
.unlocated-note { font-size: 10pt; color: #78350f; }
.unlocated-page ul { padding-left: 24px; }
.unlocated-page li { margin-bottom: 12px; font-size: 10.5pt; color: #202124; }
.unlocated-text { font-family: 'Courier New', monospace; font-size: 9.5pt; background: #f1f3f4; padding: 2px 4px; border-radius: 4px; }
.pill { font-size: 8.5pt; font-family: sans-serif; padding: 2px 8px; border-radius: 12px; font-weight: 600; display: inline-block; margin-bottom: 4px; }
.pill.ai-accepted { background: #ede9ff; color: #6d28d9; }
.pill.ai-partial  { background: #ccfbf1; color: #0f766e; }
.pill.paste       { background: #fef9c3; color: #92400e; }
.pill.gemini      { background: #e8f0fe; color: #1558b0; }

/* ── Colophon Seal Page ── */
.seal-page { font-family: 'Courier New', monospace; font-size: 10.5pt; color: #202124; }
.seal-page h2 { font-size: 14pt; letter-spacing: 0.1em; margin-bottom: 8px; color: #000; }
.seal-page hr { border: none; border-top: 1px dashed #dadce0; margin: 16px 0; }
.seal-page table { border-collapse: collapse; width: 100%; }
.seal-page td { padding: 6px 0; vertical-align: top; }
.seal-page td:first-child { width: 220px; color: #5f6368; font-weight: 600; }
.section-head { font-weight: 700; margin-top: 32px; margin-bottom: 8px; font-size: 11pt; letter-spacing: 0.05em; background: #f1f3f4; padding: 6px 12px; border-radius: 4px; }

/* ── Print / PDF Styles ── */
@media print {
  body { background: #fff; }
  .app-header { display: none !important; }
  .workspace { padding: 0; gap: 0; display: block; }
  .page { 
    width: auto; 
    min-height: auto; 
    padding: 0; 
    margin: 0; 
    box-shadow: none; 
    page-break-after: always; 
  }
  .page:last-child { page-break-after: auto; }
}
</style>
</head>
<body>

<div class="app-header">
  <div class="toolbar">
    <button onclick="window.print()">Print / Save as PDF</button>
    <span class="tip">Choose "Save as PDF" in the print dialog.</span>
  </div>
  <div class="legend">
    <div class="legend-item"><span class="swatch ai-accepted"></span> AI accepted</div>
    <div class="legend-item"><span class="swatch ai-partial"></span> AI partial</div>
    <div class="legend-item"><span class="swatch paste"></span> Pasted from external source</div>
    <div class="legend-item"><span class="swatch gemini"></span> Gemini (Help me write)</div>
  </div>
</div>

<div class="workspace">
  <div class="page">
    <div class="doc-title-banner">${esc(docTitle)}</div>
    ${driftNote ? `<div class="drift-note">${esc(driftNote)}</div>` : ''}
    
    <div class="document-content">
      ${annotatedBodyHTML}
    </div>
  </div>

  ${unlocatedSection}

  <div class="page seal-page">
    <h2>COLOPHON PROCESS LOG SEAL</h2>
    <hr>
    <table>
      <tr><td>Document</td><td>${esc(docTitle)}</td></tr>
      <tr><td>Session ID</td><td>${esc(sessionId)}</td></tr>
      <tr><td>Started</td><td>${esc(startedAt)}</td></tr>
      <tr><td>Duration</td><td>${esc(duration)}</td></tr>
      <tr><td>Exported</td><td>${esc(exportedAt)}</td></tr>
      <tr><td>Version</td><td>TWFF v0.2.0</td></tr>
    </table>
    
    <div class="section-head">EVENT SUMMARY</div>
    <table>
      <tr><td>Edits</td><td>${editCount}</td></tr>
      <tr><td>AI accepted</td><td>${aiAccepted}</td></tr>
      <tr><td>AI partial</td><td>${aiPartial}</td></tr>
      <tr><td>AI dismissed</td><td>${aiDismissed}</td></tr>
      <tr><td>External pastes</td><td>${pasteCount}</td></tr>
      <tr><td>Checkpoints</td><td>${checkpointCount}</td></tr>
    </table>
    
    <div class="section-head">ANNOTATION KEY</div>
    <table>
      <tr>
        <td><mark class="ann-ai-accepted">Purple highlight</mark></td>
        <td>AI-accepted text</td>
      </tr>
      <tr>
        <td><mark class="ann-ai-partial">Teal highlight</mark></td>
        <td>AI partially-modified text</td>
      </tr>
      <tr>
        <td><mark class="ann-paste">Amber highlight</mark></td>
        <td>Pasted from external source</td>
      </tr>
      <tr>
        <td style="padding-left: 2px;">Not highlighted</td>
        <td>User-written text</td>
      </tr>
      ${unlocated.length ? `<tr>
        <td><span class="unlocated-text">Unlocated (${unlocated.length})</span></td>
        <td>Text edited after recording — see appendix</td>
      </tr>` : ''}
    </table>
  </div>
</div>

</body>
</html>`;
}
