import JSZip from '../lib/jszip.js';

// ── File input / drag-drop ────────────────────────────────────────────────────

const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const viewerContent = document.getElementById('viewer-content');
const errorBanner   = document.getElementById('error-banner');
const pdfBtn        = document.getElementById('btn-annotated-pdf');

let _liveXhtmlStr = '';   // kept empty for live sessions (no XHTML available until export)
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
  else if (evt.type === 'checkpoint') {
    typeClass = 'user';
    const note = evt.meta?.note ?? 'Checkpoint';
    const wc = evt.meta?.word_count_total;
    authorLabel = `Checkpoint`;
    bodyHTML = `<p class="tl-text">${esc(note)}${wc != null ? ` — ${wc.toLocaleString()} words` : ''}</p>`;
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

// Fuzzy prefix match: try progressively shorter prefixes to survive minor drift.
function _fuzzyFind(haystack, needle) {
  const normH = haystack.replace(/\s+/g, ' ');
  const normN = needle.replace(/\s+/g, ' ').trim();
  for (const len of [80, 60, 40, 25, 15]) {
    const prefix = normN.slice(0, len);
    if (prefix.length < 10) break;
    const pos = normH.indexOf(prefix);
    if (pos >= 0) return pos;
  }
  return -1;
}

// Walk all text nodes under root and wrap the first match in a <mark>.
// Returns true if a match was found and wrapped.
function _wrapFirstMatch(docDom, root, needle, annType, label) {
  const normNeedle = needle.replace(/\s+/g, ' ').trim();
  const walker = docDom.createTreeWalker(root, 0x4 /* NodeFilter.SHOW_TEXT */);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);

  // Build concatenated text, preserving node boundaries
  let concat = '';
  const offsets = []; // offsets[i] = start index of nodes[i] in concat
  for (const n of nodes) {
    offsets.push(concat.length);
    concat += n.textContent;
  }

  const pos = _fuzzyFind(concat, normNeedle);
  if (pos < 0) return false;

  const matchEnd = pos + normNeedle.slice(0, 80).length;

  // Find the single text node that contains pos (most common case)
  for (let i = 0; i < nodes.length; i++) {
    const start = offsets[i];
    const end   = start + nodes[i].textContent.length;
    if (start <= pos && pos < end) {
      const n = nodes[i];
      const localStart = pos - start;
      const localEnd   = Math.min(matchEnd - start, n.textContent.length);
      const before = n.textContent.slice(0, localStart);
      const match  = n.textContent.slice(localStart, localEnd);
      const after  = n.textContent.slice(localEnd);
      if (!match) return false;

      const mark = docDom.createElement('mark');
      mark.className = `ann-${annType}`;
      mark.title = label;
      mark.textContent = match;

      const parent = n.parentNode;
      if (before) parent.insertBefore(docDom.createTextNode(before), n);
      parent.insertBefore(mark, n);
      if (after) parent.insertBefore(docDom.createTextNode(after), n);
      parent.removeChild(n);
      return true;
    }
  }
  return false;
}

function openAnnotatedView(log, meta, xhtmlStr) {
  const events   = log.events ?? [];
  const docTitle = meta.title || log.title || 'Untitled document';

  // Parse the stored XHTML — preserve structure and original styles
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
    let annType = null, label = null, searchText = null;
    if (evt.type === 'ai_interaction') {
      const acc = evt.meta?.acceptance;
      if (acc === 'fully_accepted')          { annType = 'ai-accepted'; label = 'AI accepted'; }
      else if (acc === 'partially_modified') { annType = 'ai-partial';  label = 'AI (partial)'; }
      else continue;
      searchText = evt.meta?.output_preview;
    } else if (evt.type === 'paste' && evt.meta?.output_preview) {
      annType = 'paste'; label = 'Pasted'; searchText = evt.meta.output_preview;
    } else { continue; }
    if (!searchText || searchText.length < 10) continue;
    annotations.push({ type: annType, label, text: searchText });
  }

  // Inject marks into the parsed DOM; collect those that couldn't be found
  const unlocated = [];
  if (docDom) {
    for (const ann of annotations) {
      const found = _wrapFirstMatch(docDom, docDom.body, ann.text, ann.type, ann.label);
      if (!found) unlocated.push(ann);
    }
  } else {
    unlocated.push(...annotations);
  }

  // Serialize the annotated body HTML
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
    log,
    editCount, aiAccepted, aiPartial, aiDismissed, pasteCount, checkpointCount,
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
    <div class="unlocated page-break">
      <h2 class="unlocated-title">Unlocated annotations (${unlocated.length})</h2>
      <p class="unlocated-note">These could not be matched to the stored document text. This indicates the text was edited after the event was recorded (positional drift).</p>
      <ul>
        ${unlocated.map(a => `<li><span class="pill ${esc(a.type)}">${esc(a.label)}</span> ${esc(a.text.slice(0, 140))}${a.text.length > 140 ? '…' : ''}</li>`).join('')}
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
/* ── Annotation overlay styles ── */
* { box-sizing: border-box; }
body { background: #fff; }
.toolbar { position: sticky; top: 0; z-index: 100; background: #f1f5f9; border-bottom: 1px solid #cbd5e1; padding: 10px 24px; display: flex; align-items: center; gap: 16px; font-family: sans-serif; }
.toolbar button { padding: 6px 16px; background: #4f46e5; color: #fff; border: none; border-radius: 6px; font-size: 10pt; cursor: pointer; }
.toolbar .tip { font-size: 9pt; color: #64748b; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; padding: 8px 24px 6px; border-bottom: 1px solid #e2e8f0; background: #fff; font-family: sans-serif; }
.legend-item { display: flex; align-items: center; gap: 6px; font-size: 9pt; color: #374151; }
.legend-item .swatch { width: 14px; height: 14px; border-radius: 3px; display: inline-block; }
.swatch.ai-accepted { background: #ede9ff; border: 1.5px solid #7c3aed; }
.swatch.ai-partial  { background: #ccfbf1; border: 1.5px solid #0d9488; }
.swatch.paste       { background: #fef9c3; border: 1.5px solid #ca8a04; }
.doc-title-banner { font-family: sans-serif; font-size: 11pt; font-weight: 700; color: #0f172a; padding: 16px 32px 0; max-width: 900px; margin: 0 auto; }
.drift-note { font-family: sans-serif; font-size: 9pt; color: #92400e; padding: 4px 32px 0; max-width: 900px; margin: 0 auto; }
mark.ann-ai-accepted { background: #ede9ff; border-bottom: 2px solid #7c3aed; border-radius: 2px; padding: 0 1px; }
mark.ann-ai-partial  { background: #ccfbf1; border-bottom: 2px solid #0d9488; border-radius: 2px; padding: 0 1px; }
mark.ann-paste       { background: #fef9c3; border-bottom: 2px solid #ca8a04; border-radius: 2px; padding: 0 1px; }
.unlocated { max-width: 900px; margin: 24px auto; padding: 16px 32px; background: #fefce8; border: 1px solid #fde047; border-radius: 8px; font-family: sans-serif; }
.unlocated-title { font-size: 11pt; font-weight: 600; color: #854d0e; margin-bottom: 6px; }
.unlocated-note { font-size: 8.5pt; color: #78350f; margin-bottom: 8px; }
.unlocated ul { padding-left: 18px; font-size: 9.5pt; }
.unlocated li { margin-bottom: 5px; }
.pill { font-size: 8pt; font-family: sans-serif; padding: 1px 6px; border-radius: 10px; font-weight: 600; vertical-align: middle; }
.pill.ai-accepted { background: #ede9ff; color: #6d28d9; }
.pill.ai-partial  { background: #ccfbf1; color: #0f766e; }
.pill.paste       { background: #fef9c3; color: #92400e; }
.page-break { break-before: page; }
.seal { max-width: 900px; margin: 0 auto; padding: 48px 32px; font-family: 'Courier New', monospace; font-size: 10pt; }
.seal h2 { font-size: 13pt; letter-spacing: 0.1em; margin-bottom: 4px; }
.seal hr { border: none; border-top: 1px solid #94a3b8; margin: 12px 0; }
.seal table { border-collapse: collapse; width: 100%; }
.seal td { padding: 2px 0; vertical-align: top; }
.seal td:first-child { width: 180px; color: #64748b; }
.seal .section-head { font-weight: 700; margin-top: 16px; margin-bottom: 4px; font-size: 10pt; letter-spacing: 0.05em; }
@media print {
  .toolbar, .legend, .doc-title-banner, .drift-note { display: none !important; }
  body { font-size: 10pt; }
}
</style>
</head>
<body>

<div class="toolbar">
  <button onclick="window.print()">Print / Save as PDF</button>
  <span class="tip">Choose "Save as PDF" in the print dialog.</span>
</div>

<div class="legend">
  <div class="legend-item"><span class="swatch ai-accepted"></span> AI accepted</div>
  <div class="legend-item"><span class="swatch ai-partial"></span> AI partial</div>
  <div class="legend-item"><span class="swatch paste"></span> Pasted from external source</div>
</div>

<div class="doc-title-banner">${esc(docTitle)}</div>
${driftNote ? `<div class="drift-note">${esc(driftNote)}</div>` : ''}

${annotatedBodyHTML}

${unlocatedSection}

<div class="seal page-break">
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
  <hr>
  <div class="section-head">EVENT SUMMARY</div>
  <table>
    <tr><td>Edits</td><td>${editCount}</td></tr>
    <tr><td>AI accepted</td><td>${aiAccepted}</td></tr>
    <tr><td>AI partial</td><td>${aiPartial}</td></tr>
    <tr><td>AI dismissed</td><td>${aiDismissed}</td></tr>
    <tr><td>External pastes</td><td>${pasteCount}</td></tr>
    <tr><td>Checkpoints</td><td>${checkpointCount}</td></tr>
  </table>
  <hr>
  <div class="section-head">ANNOTATION KEY</div>
  <table>
    <tr><td>Purple highlight</td><td>AI-accepted text</td></tr>
    <tr><td>Teal highlight</td><td>AI partially-modified text</td></tr>
    <tr><td>Amber highlight</td><td>Pasted from external source</td></tr>
    <tr><td>Not highlighted</td><td>User-written text</td></tr>
    ${unlocated.length ? `<tr><td>Unlocated (${unlocated.length})</td><td>Text edited after recording — see appendix</td></tr>` : ''}
  </table>
</div>

</body>
</html>`;
}
