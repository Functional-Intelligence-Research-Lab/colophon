import JSZip from '../lib/jszip.js';
import DOMPurify from 'dompurify';
import { computeAnnotations, compositeKey } from '../lib/annotate.js';
import { esc } from '../shared/esc.js';
import { finiteNumber } from '../shared/num.js';
import { getSourceToolLabel } from '../shared/source-tools.js';

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
  // Normalize the pre-v0.2 'edit' type string (older exported .twff files)
  // to 'edit_block', so both old and new files render the same way here.
  const events = (log.events ?? []).map(e => (
    e.type === 'edit' ? { ...e, type: 'edit_block' } : e
  ));

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
  const editCount = events.filter(e => e.type === 'edit_block').length;
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
  else if (evt.type === 'edit_block') {
    authorLabel = 'You • Edited';
    const delta = finiteNumber(evt.meta?.char_delta);
    bodyHTML = `<p class="tl-text">${delta > 0 ? '+' : ''}${delta} characters</p>`;
  }
  else if (evt.type === 'paste') {
    authorLabel = 'You • Pasted';
    const chars = finiteNumber(evt.meta?.char_count);
    bodyHTML = `<p class="tl-text">${chars} chars from external source</p>`;
    if (evt.meta?.source_tool) {
      const history = evt.meta?.source_tool_history;
      const correctedNote = history?.length > 1
        ? `, corrected from ${esc(getSourceToolLabel(history[0].value))}`
        : '';
      bodyHTML += `<p class="tl-source-tool" style="margin:4px 0;"><span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:0.75rem;background:#f3f4f6;border:1px solid #d1d5db;color:#374151;">Self-reported source: ${esc(getSourceToolLabel(evt.meta.source_tool))}${correctedNote}</span></p>`;
    }
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
    const chars = finiteNumber(evt.meta?.char_count);
    const vel = finiteNumber(evt.meta?.insertion_velocity, null);
    const preview = evt.meta?.output_preview ? esc(evt.meta.output_preview) : `${chars} chars inserted`;
    bodyHTML = `<p class="tl-text">${preview}${vel ? ` <span style="color:#888;font-size:0.85em">(${vel} chars/s)</span>` : ''}</p>`;
  }
  else if (evt.type === 'checkpoint') {
    typeClass = 'user';
    const note = evt.meta?.note ?? 'Checkpoint';
    const wc = finiteNumber(evt.meta?.word_count_total, null);
    authorLabel = `Checkpoint`;
    bodyHTML = `<p class="tl-text">${esc(note)}${wc !== null ? ` · ${wc.toLocaleString()} words` : ''}</p>`;
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
  return `<div class="tl-node"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2z"/></svg></div>`;
}

function solidNode(svgInner) {
  return `<div class="tl-node solid">${svgInner}</div>`;
}

function checkIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
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

// paste/ai mirror shared/theme.css's own --paste-color/--paste-bg and
// --ai-color/--ai-bg exactly (this standalone report can't load that
// stylesheet live — it's built as a Blob and opened via window.open — so
// the resolved hex is inlined here instead; update both together).
// paste-ai-disclosed reuses shared/theme.css's own
// --status-warn-bg/--status-warn-fg rather than inventing a fifth hue: an
// unverified self-report is exactly the "proceed with caution" case that
// token already exists for.
const LEGEND = {
  paste: { label: 'Pasted from external source', bg: '#fdf0d9', border: '#c98500' },
  'paste-ai-disclosed': { label: 'Self-reported AI-generated paste (not independently verified)', bg: '#fef3c7', border: '#92400e' },
  ai: { label: 'AI-generated, accepted', bg: '#f2effc', border: '#4a3aa7' },
  'ai-partial': { label: 'AI-suggested, partially kept', bg: '#ccfbf1', border: '#0d9488' },
  // compositeKey() joins per-layer tags with '-then-'; classifyLayer() never
  // produces a tag literally called "edited" (only 'human'), so the string
  // 'ai-then-edited' could never actually be generated here — AI content
  // later edited by a person always composites to 'ai-then-human', which
  // this entry was presumably meant to label. Was silently falling through
  // to DEFAULT_SWATCH for one of the single most important histories this
  // product exists to show.
  'ai-then-human': { label: 'AI-generated, then human-edited', bg: '#dbeafe', border: '#3b82f6' },
  'paste-then-ai': { label: 'Pasted, then AI-paraphrased', bg: '#fde7f3', border: '#c026d3' },
  'human-then-ai': { label: 'Human draft, then AI-revised', bg: '#dbeafe', border: '#3b82f6' },
  // Pasted content a person later typed over, in whole or in part — the
  // central scenario this project's own bug reports kept surfacing, so it
  // gets a real label rather than the generic composite fallback too.
  'paste-then-human': { label: 'Pasted, then edited by the author', bg: '#d4f0e2', border: '#15803d' },
};
const DEFAULT_SWATCH = { label: 'Composite provenance — see tooltip', bg: '#e5e7eb', border: '#6b7280' };

// A single "X%" when the engine knows exactly what happened everywhere; a
// "min–max%" range the moment it doesn't (stats.untrackedCount > 0) — the
// range IS the headline figure in that case, not an asterisk pointing at a
// footnote, so a reader can't miss that the number is a bound, not a fact.
function formatCoverage(min, max) {
  return min === max ? `${min}%` : `${min}–${max}%`;
}

const TYPE_LABELS = {
  edit_block: 'edit', edit: 'edit', paste: 'pasted passage',
  ai_interaction: 'AI suggestion', ai_suggestion: 'AI suggestion',
  focus_change: 'focus change', checkpoint: 'checkpoint',
};
function typeLabel(type) {
  return TYPE_LABELS[type] ?? type;
}
function pluralize(label, count) {
  return count === 1 ? label : `${label}s`;
}

const UNLOCATED_REASONS = {
  'unlocated-no-snapshot': () => 'had no earlier recorded text to compare against this draft. This is common for very small edits and is expected, not a sign of tampering',
  'unlocated-no-match': (count) => `${count === 1 ? "doesn't" : "don't"} appear anywhere in the final document in a way we could confidently match. This usually means the text was replaced or heavily rewritten`,
};

// Collapses a list of { event, reason } entries into one row per distinct
// (type, reason) pair with a count, so e.g. seven unmatched edits for the
// same reason render as one line instead of seven identical ones.
function groupByTypeAndReason(list) {
  const groups = new Map();
  for (const item of list) {
    const label = typeLabel(item.event.type);
    const key = `${label}::${item.reason}`;
    if (!groups.has(key)) groups.set(key, { label, reason: item.reason, count: 0 });
    groups.get(key).count += 1;
  }
  return Array.from(groups.values());
}

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

  // annotatedBodyHTML above came from a DOM node DOMPurify already sanitized
  // IN_PLACE (annotate.js's computeAnnotations()) — but it's then serialized
  // back to a string and concatenated into this larger page template, which
  // the browser will parse as a brand new document a second time via
  // window.open() below. Serializing sanitized DOM and re-inserting it as a
  // string without re-sanitizing is exactly DOMPurify's own documented
  // mutation-XSS (mXSS) precondition — content that was safe as a live DOM
  // tree can behave differently once serialized and re-parsed. Re-sanitize
  // the fully assembled string, in string mode, right before it's used.
  // ADD_TAGS: ['meta'] keeps <meta charset="UTF-8"> alive as defense in
  // depth — DOMPurify's WHOLE_DOCUMENT mode doesn't add 'meta' to its tag
  // allow-list by default (confirmed against this project's own
  // purify.min.js), so it would otherwise be silently stripped here. The
  // Blob's own explicit charset below is the real fix either way, since
  // that's what actually governs decoding once this becomes a blob: URL —
  // with neither, the browser has zero encoding signal and falls back to a
  // legacy single-byte encoding, corrupting every multi-byte UTF-8
  // character (the mojibake seen in "Duration: —").
  const safeHtml = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true, ADD_TAGS: ['meta'] });
  const blob = new Blob([safeHtml], { type: 'text/html;charset=utf-8' });
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

  const supersededGroups = groupByTypeAndReason(supersededList);
  const supersededSection = !supersededList.length ? '' : `
      <div class="appendix-banner superseded-banner">
        <h2 class="appendix-title">Replaced before the final draft (${supersededList.length})</h2>
        <p class="appendix-note">This content was recorded at the time, then later fully deleted or overwritten before the session ended — it no longer appears in the final document, so it isn't highlighted above.</p>
      </div>
      <ul>
        ${supersededGroups.map((g) => `<li><span class="pill superseded">${g.count}</span> ${esc(pluralize(g.label, g.count))} ${g.count === 1 ? 'was' : 'were'} later deleted or overwritten before the document was finished.</li>`).join('')}
      </ul>`;

  const unlocatedGroups = groupByTypeAndReason(unlocatedList);
  const unlocatedSection = !unlocatedList.length ? '' : `
      <div class="appendix-banner unlocated-banner">
        <h2 class="appendix-title">Couldn't be verified (${unlocatedList.length})</h2>
        <p class="appendix-note">These couldn't be matched to the final document text with confidence — likely edited beyond recognition, or with too little surrounding context to search for.</p>
      </div>
      <ul>
        ${unlocatedGroups.map((g) => `<li><span class="pill unlocated">${g.count}</span> ${esc(pluralize(g.label, g.count))} ${esc((UNLOCATED_REASONS[g.reason]?.(g.count)) ?? g.reason)}.</li>`).join('')}
      </ul>`;

  // Both sections share one printed page instead of each forcing its own —
  // .page gets page-break-after: always under @media print, so two
  // separate .appendix-page divs always meant two sheets even when their
  // combined content was a few lines. id="appendix" is the target of the
  // seal's own coverage-row links below — nothing on the seal previously
  // signaled this section even existed.
  const appendixSection = (!supersededList.length && !unlocatedList.length) ? '' : `
    <div class="page appendix-page" id="appendix">
      ${supersededSection}
      ${unlocatedSection}
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
  padding-top: 16px;
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
  background: #15803d; /* brand green, matches colophon-web's report */
  color: #fff;
  border: none;
  border-radius: 4px;
  font-size: 10pt;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}
.toolbar button:hover { background: #166534; }
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
.ann-tip { display: none; }
.ann-paste          { background: ${LEGEND.paste.bg}; border-bottom: 2px solid ${LEGEND.paste.border}; }
.ann-paste-ai-disclosed { background: ${LEGEND['paste-ai-disclosed'].bg}; border-bottom: 2px solid ${LEGEND['paste-ai-disclosed'].border}; }
.ann-ai             { background: ${LEGEND.ai.bg}; border-bottom: 2px solid ${LEGEND.ai.border}; }
.ann-ai-partial     { background: ${LEGEND['ai-partial'].bg}; border-bottom: 2px solid ${LEGEND['ai-partial'].border}; }
.ann-ai-then-human  { background: ${LEGEND['ai-then-human'].bg}; border-bottom: 2px solid ${LEGEND['ai-then-human'].border}; }
.ann-paste-then-ai  { background: ${LEGEND['paste-then-ai'].bg}; border-bottom: 2px solid ${LEGEND['paste-then-ai'].border}; }
.ann-human-then-ai  { background: ${LEGEND['human-then-ai'].bg}; border-bottom: 2px solid ${LEGEND['human-then-ai'].border}; }
.ann-paste-then-human { background: ${LEGEND['paste-then-human'].bg}; border-bottom: 2px solid ${LEGEND['paste-then-human'].border}; }
.ann-composite      { background: ${DEFAULT_SWATCH.bg}; border-bottom: 2px solid ${DEFAULT_SWATCH.border}; }

/* ── Appendix pages (superseded / unlocated) ──
   Rounded, flat-tint banners — no left-border accent bar, which read as a
   generic "AI-generated warning box" rather than a plain informational
   note. Unlocated is deliberately neutral gray, not yellow/amber: an
   unlocated event is explicitly not a red flag, and a cautionary color
   was sending the wrong signal for something that just means "too small
   to trace," not "something's wrong." */
.appendix-banner { padding: 16px 20px; margin-bottom: 20px; border-radius: 8px; }
.superseded-banner { background: #eff6ff; color: #1d4ed8; }
.unlocated-banner { background: #f1f3f4; color: #5f6368; }
.appendix-title { font-size: 13.5pt; font-weight: 700; margin-bottom: 6px; }
.appendix-note { font-size: 10.5pt; opacity: 0.9; }
.appendix-page ul { padding-left: 24px; }
.appendix-page li { margin-bottom: 12px; font-size: 10.5pt; }
.pill { font-size: 8.5pt; font-family: sans-serif; padding: 2px 8px; border-radius: 12px; font-weight: 600; display: inline-block; margin-right: 6px; }
.pill.superseded { background: #dbeafe; color: #1d4ed8; }
.pill.unlocated  { background: #e8eaed; color: #5f6368; }

/* ── Colophon Seal Page ── */
/* Matches colophon-web's report.js brand treatment — plain Arial, brand
   green accent, rounded section headers — instead of a Courier New
   "receipt" look that read as visually disconnected from the rest of the
   report (and from the rest of the product's actual brand). */
.seal-page { font-family: Arial, sans-serif; font-size: 10.5pt; color: #202124; }
.seal-page h2 { font-size: 15pt; font-weight: 700; color: #15803d; margin-bottom: 8px; }
.seal-page hr { border: none; border-top: 1px solid #e5e7eb; margin: 16px 0; }
.seal-page table { border-collapse: collapse; width: 100%; }
.seal-page td { padding: 6px 0; vertical-align: top; }
.seal-page td:first-child { width: 220px; color: #5f6368; font-weight: 600; }
.section-head { font-weight: 700; margin-top: 32px; margin-bottom: 8px; font-size: 11pt; color: #15803d; background: #d4f0e2; padding: 6px 12px; border-radius: 8px; }
.untracked-note { font-size: 9.5pt; color: #5f6368; margin-top: 4px; font-style: italic; }

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
  <div class="legend">${legendRows}</div>
</div>

<div class="workspace">
  <div class="page">
    <div class="doc-title-banner">${esc(docTitle)}</div>

    <div class="document-content">
      ${annotatedBodyHTML}
    </div>
  </div>

  ${appendixSection}

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
      <tr><td>AI-derived coverage</td><td>${formatCoverage(stats.aiCoverageMin, stats.aiCoverageMax)}</td></tr>
      <tr><td>Pasted-content coverage</td><td>${formatCoverage(stats.pasteCoverageMin, stats.pasteCoverageMax)}</td></tr>
    </table>
    ${stats.untrackedCount ? `<p class="untracked-note">${stats.untrackedCount} edit${stats.untrackedCount === 1 ? '' : 's'}
      couldn't be precisely located in this version of the document (see the <a href="#appendix">appendix</a>) — the coverage
      figures above are shown as a range to reflect that, not a single falsely-exact number.</p>` : ''}

    <div class="section-head">ANNOTATION KEY</div>
    <table>
      ${usedKeys.map((key) => {
        const sw = LEGEND[key] ?? DEFAULT_SWATCH;
        return `<tr><td><span class="ann ann-${key}">Highlight</span></td><td>${esc(sw.label)}</td></tr>`;
      }).join('')}
      <tr><td style="padding-left: 2px;">Not highlighted</td><td>No activity captured here — consistent with the author's own typing, but not proof of it: a gap in recording, text written outside this document, or external text retyped by hand would all look the same</td></tr>
      ${supersededList.length ? `<tr>
        <td><span class="pill superseded">Replaced</span></td>
        <td>Recorded, later deleted — see the <a href="#appendix">appendix</a></td>
      </tr>` : ''}
      ${unlocatedList.length ? `<tr>
        <td><span class="pill unlocated">Unverified</span></td>
        <td>Could not be matched — see the <a href="#appendix">appendix</a></td>
      </tr>` : ''}
    </table>
  </div>
</div>

</body>
</html>`;
}
