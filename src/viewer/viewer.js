import JSZip from '../lib/jszip.js';
import { computeAnnotations, compositeKey } from '../lib/annotate.js';
import { esc } from '../shared/esc.js';

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
//
// Drift-corrected: delegates to lib/annotate.js's computeAnnotations(), which
// classifies each event's recorded offset as trustworthy or not, forward-maps
// trustworthy offsets through later edits, verifies the result against the
// event's own text snapshot, and only falls back to fuzzy search (disambiguated
// by proximity) when that fails — instead of this viewer's old pure-fuzzy-search
// approach, which had no way to detect or correct for drift at all.

const LEGEND = {
  paste: { label: 'Pasted from external source', bg: '#fef9c3', border: '#ca8a04' },
  ai: { label: 'AI-generated, accepted', bg: '#ede9ff', border: '#7c3aed' },
  'ai-partial': { label: 'AI-suggested, partially kept', bg: '#ccfbf1', border: '#0d9488' },
  'ai-then-edited': { label: 'AI-generated, then human-edited', bg: '#dbeafe', border: '#3b82f6' },
  'paste-then-ai': { label: 'Pasted, then AI-paraphrased', bg: '#fde7f3', border: '#c026d3' },
  'human-then-ai': { label: 'Human draft, then AI-revised', bg: '#dbeafe', border: '#3b82f6' },
};
const DEFAULT_SWATCH = { label: 'Composite provenance — see tooltip', bg: '#e5e7eb', border: '#6b7280' };

function openAnnotatedView(log, meta, xhtmlStr) {
  const docTitle = meta.title || log.title || 'Untitled document';

  let computed;
  try {
    computed = computeAnnotations(xhtmlStr, log);
  } catch (err) {
    showError(`Could not annotate this document: ${err.message}`);
    return;
  }

  // Preserve the original Google Docs <style> block — Docs exports rich
  // formatting (bold, headers) as CSS classes, not inline attributes, so
  // without this the annotated report would lose most of its formatting.
  let xhtmlStyles = '';
  try {
    const styleDom = new DOMParser().parseFromString(xhtmlStr, 'text/html');
    xhtmlStyles = Array.from(styleDom.querySelectorAll('style')).map(s => s.textContent).join('\n');
    // Defensive: this string gets concatenated into a <style> block via a
    // template literal, not a DOM API, so a literal "</style" would break
    // out of the block — can't actually occur from a real <style> element's
    // textContent, but escape it anyway as cheap insurance.
    xhtmlStyles = xhtmlStyles.replace(/<\/style/gi, '<\\/style');
  } catch { /* no preserved styles */ }

  const usedKeys = [];
  const seenKeys = new Set();
  for (const r of computed.provenanceRanges) {
    const key = compositeKey(r.history);
    if (key !== 'human' && !seenKeys.has(key)) {
      seenKeys.add(key);
      usedKeys.push(key);
    }
  }

  const events   = log.events ?? [];
  const startEvt = events.find(e => e.type === 'session_start');
  const endEvt   = events.find(e => e.type === 'session_end');
  const startTs  = startEvt?.timestamp ?? log.startTime ?? null;
  const endTs    = endEvt?.timestamp ?? null;
  const durationMs = startTs && endTs ? new Date(endTs) - new Date(startTs) : null;

  const html = _buildAnnotatedPageHTML({
    docTitle,
    annotatedBodyHTML: computed.annotatedDom.innerHTML,
    xhtmlStyles,
    stats: computed.stats,
    supersededList: computed.supersededList,
    unlocatedList: computed.unlocatedList,
    usedKeys,
    log, startTs, durationMs,
  });

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  if (!win) {
    showError('Could not open the annotated report — your browser may have blocked the pop-up. Allow pop-ups for this page and try again.');
    URL.revokeObjectURL(url);
    return;
  }
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

function _buildAnnotatedPageHTML({
  docTitle, annotatedBodyHTML, xhtmlStyles, stats, supersededList, unlocatedList, usedKeys,
  log, startTs, durationMs,
}) {
  const exportedAt = new Date().toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const startedAt = startTs ? fmtDatetime(startTs) : '—';
  const duration  = durationMs !== null ? fmtDuration(durationMs) : '—';
  const sessionId = log.sessionId ? log.sessionId.slice(0, 8) : '—';

  const legendRows = usedKeys.map((key) => {
    const sw = LEGEND[key] ?? DEFAULT_SWATCH;
    return `<div class="legend-item"><span class="swatch" style="background:${sw.bg};border-color:${sw.border}"></span> ${esc(sw.label)}</div>`;
  }).join('');

  const supersededSection = !supersededList.length ? '' : `
    <div class="page appendix-page">
      <div class="appendix-banner superseded-banner">
        <h2 class="appendix-title">Superseded content (${supersededList.length})</h2>
        <p class="appendix-note">This content was recorded at the time, then later fully deleted or overwritten before the session ended — it no longer appears in the final document, so it isn't highlighted above.</p>
      </div>
      <ul>
        ${supersededList.map((s) => `<li><span class="pill superseded">${esc(s.event.type)}</span> ${esc(s.reason)}</li>`).join('')}
      </ul>
    </div>`;

  const unlocatedSection = !unlocatedList.length ? '' : `
    <div class="page appendix-page">
      <div class="appendix-banner unlocated-banner">
        <h2 class="appendix-title">Unlocated events (${unlocatedList.length})</h2>
        <p class="appendix-note">These couldn't be matched to the final document text with confidence — likely edited beyond recognition, or with too little surrounding context to search for.</p>
      </div>
      <ul>
        ${unlocatedList.map((u) => `<li><span class="pill unlocated">${esc(u.event.type)}</span> ${esc(u.reason)}</li>`).join('')}
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
.legend-item .swatch { width: 14px; height: 14px; border-radius: 3px; display: inline-block; border: 1.5px solid; }

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
  margin-bottom: 24px;
  border-bottom: 1px solid #dadce0;
  padding-bottom: 12px;
}

/* ── Document Content Formatting ── */
.document-content {
  font-size: 11pt;
  color: #000;
  overflow-wrap: break-word;
}
.document-content img { max-width: 100%; height: auto; }

/* ── Highlighting ── */
.ann { border-radius: 2px; padding: 0 1px; }
.ann-paste          { background: ${LEGEND.paste.bg}; border-bottom: 2px solid ${LEGEND.paste.border}; }
.ann-ai             { background: ${LEGEND.ai.bg}; border-bottom: 2px solid ${LEGEND.ai.border}; }
.ann-ai-partial     { background: ${LEGEND['ai-partial'].bg}; border-bottom: 2px solid ${LEGEND['ai-partial'].border}; }
.ann-ai-then-edited { background: ${LEGEND['ai-then-edited'].bg}; border-bottom: 2px solid ${LEGEND['ai-then-edited'].border}; }
.ann-paste-then-ai  { background: ${LEGEND['paste-then-ai'].bg}; border-bottom: 2px solid ${LEGEND['paste-then-ai'].border}; }
.ann-human-then-ai  { background: ${LEGEND['human-then-ai'].bg}; border-bottom: 2px solid ${LEGEND['human-then-ai'].border}; }
.ann-composite      { background: ${DEFAULT_SWATCH.bg}; border-bottom: 2px solid ${DEFAULT_SWATCH.border}; }

/* ── Appendix pages (superseded / unlocated) ── */
.appendix-banner { padding: 16px 24px; margin-bottom: 24px; }
.superseded-banner { background: #eff6ff; border-left: 4px solid #60a5fa; }
.unlocated-banner { background: #fefce8; border-left: 4px solid #fde047; }
.appendix-title { font-size: 12pt; font-weight: 600; margin-bottom: 6px; }
.appendix-note { font-size: 10pt; color: #444; }
.appendix-page ul { padding-left: 24px; }
.appendix-page li { margin-bottom: 12px; font-size: 10.5pt; }
.pill { font-size: 8.5pt; font-family: sans-serif; padding: 2px 8px; border-radius: 12px; font-weight: 600; display: inline-block; margin-right: 6px; }
.pill.superseded { background: #dbeafe; color: #1d4ed8; }
.pill.unlocated  { background: #fef9c3; color: #854d0e; }

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
  <div class="legend">${legendRows}</div>
</div>

<div class="workspace">
  <div class="page">
    <div class="doc-title-banner">${esc(docTitle)}</div>

    <div class="document-content">
      ${annotatedBodyHTML}
    </div>
  </div>

  ${supersededSection}
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
      <tr><td>Edits</td><td>${stats.editCount}</td></tr>
      <tr><td>AI accepted/modified</td><td>${stats.aiAccepted}</td></tr>
      <tr><td>AI dismissed</td><td>${stats.aiDismissed}</td></tr>
      <tr><td>External pastes</td><td>${stats.pasteCount}</td></tr>
      <tr><td>AI-derived coverage</td><td>${stats.aiCoveragePct}%</td></tr>
      <tr><td>Pasted-content coverage</td><td>${stats.pasteCoveragePct}%</td></tr>
    </table>

    <div class="section-head">ANNOTATION KEY</div>
    <table>
      ${usedKeys.map((key) => {
        const sw = LEGEND[key] ?? DEFAULT_SWATCH;
        return `<tr><td><span class="ann ann-${key}">Highlight</span></td><td>${esc(sw.label)}</td></tr>`;
      }).join('')}
      <tr><td style="padding-left: 2px;">Not highlighted</td><td>Original human authorship</td></tr>
      ${supersededList.length ? `<tr>
        <td><span class="pill superseded">Superseded</span></td>
        <td>Recorded, later deleted — see appendix</td>
      </tr>` : ''}
      ${unlocatedList.length ? `<tr>
        <td><span class="pill unlocated">Unlocated</span></td>
        <td>Could not be matched — see appendix</td>
      </tr>` : ''}
    </table>
  </div>
</div>

</body>
</html>`;
}
