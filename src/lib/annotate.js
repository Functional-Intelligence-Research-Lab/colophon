/**
 * Colophon TWFF annotation engine.
 *
 * Computes a drift-corrected, provenance-aware annotation of a document
 * (content/document.xhtml) from its process log (meta/process-log.json).
 *
 * Design notes:
 *  - The real extension does not reliably log usable position offsets for
 *    most event types today (position_start is hardcoded to 0 at most call
 *    sites except clipboard pastes). Offsets are therefore treated as a
 *    signal to verify, never trusted blindly — every offset-derived range is
 *    cross-checked against the event's own recorded text snapshot before
 *    use, and falls back to fuzzy text search when it doesn't check out.
 *  - There is no separate "calibrate the document's line-break convention"
 *    pre-pass: fuzzy matching already whitespace-normalizes on both sides,
 *    so small linearization mismatches (this file uses plain text-node
 *    concatenation with no inserted separators) self-correct through the
 *    verify-then-fuzzy-fallback path rather than needing an up-front anchor
 *    search that might not find a suitable event to calibrate against.
 *  - Everything here is pure/data-in-data-out except the final DOM-wrapping
 *    step, which mutates a detached document fragment (never the live page).
 */

import DOMPurify from 'dompurify';

const KNOWN_TYPES = new Set([
  'session_start', 'session_end', 'session_resume',
  'edit_block', 'edit',
  'paste', 'paste_link', 'image_upload',
  'ai_interaction', 'ai_suggestion',
  'checkpoint', 'focus_change', 'chat_interaction',
]);

const LENGTH_CHANGING_TYPES = new Set(['edit_block', 'paste', 'ai_interaction', 'ai_suggestion']);

// ── 1. Event normalization ──────────────────────────────────────────────
// Tolerates both the documented flat schema (edit_block/schema.json) and the
// real producer's meta-wrapped shape (edit/SPEC.md + undocumented extras).
export function normalizeEvent(raw, index) {
  const f = raw.meta ?? raw;
  let type = raw.type;
  if (type === 'edit') type = 'edit_block';
  if (!KNOWN_TYPES.has(type)) type = 'ignored';

  const desentinel = (s) => (s == null || s === '' || s === '[snapshot unavailable]' ? null : s);

  const posStart = numOrNull(f.position_start);
  const posEnd = numOrNull(f.position_end);
  const contentBefore = desentinel(f.content_before);
  const contentAfter = desentinel(f.content_after);

  const lengthHint =
    numOrNull(f.char_delta) ??
    (contentBefore != null && contentAfter != null ? contentAfter.length - contentBefore.length : null) ??
    (posStart != null && posEnd != null ? posEnd - posStart : null);

  return {
    id: `${index}:${raw.timestamp ?? ''}:${type}`,
    index,
    tsMs: Date.parse(raw.timestamp) || index, // fall back to index order if timestamp is unparseable
    type,
    source: f.source ?? null,
    model: f.model ?? null,
    acceptance: f.acceptance ?? null, // preserved verbatim, including the real producer's non-spec "pending"
    posStart, posEnd,
    contentBefore, contentAfter,
    preview: f.output_preview ?? f.content_preview ?? null,
    charCount: numOrNull(f.char_count) ?? numOrNull(f.ai_chars),
    lengthHint,
    raw,
  };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ── 2. Linearize the document into plain text + text-node offset table ──
export function linearizeDom(bodyEl) {
  const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
  const nodes = [];
  const offsets = [];
  let text = '';
  let node;
  while ((node = walker.nextNode())) {
    offsets.push(text.length);
    nodes.push(node);
    text += node.textContent;
  }
  return { text, nodes, offsets };
}

// ── 3. Per-event position-reliability classification ────────────────────
// Three outcomes: 'position' (trust the offset), 'length-only' (offset is
// garbage, but the length/char count is usable for bookkeeping), 'none'.
export function classifyReliability(e, docLenEstimate) {
  if (e.posStart == null || e.posEnd == null) return 'none';
  if (e.posStart < 0 || e.posEnd < e.posStart) return 'none';

  if (e.posStart === 0 && e.posEnd === 0) {
    return docLenEstimate === 0 ? 'position' : 'none';
  }
  if (e.posStart === 0 && e.posEnd > 0) {
    // Paste events are the one type whose (0, N) pairs are occasionally
    // genuine (a paste at the very start of the document) — verified by
    // internal consistency with char_count. Everything else hitting this
    // branch matches the known producer bug where position_end is really a
    // length, not an endpoint.
    if (e.type === 'paste' && e.charCount != null && (e.posEnd - e.posStart) === e.charCount) {
      return 'position';
    }
    return 'length-only';
  }
  if (e.contentAfter != null && Math.abs((e.posEnd - e.posStart) - e.contentAfter.length) > 2) {
    return 'length-only';
  }
  return 'position';
}

// ── 4. Shift oplog + forward position mapping (drift correction) ────────
function insertedLength(e) {
  if (e.contentAfter != null && e.contentAfter.length < 500) return e.contentAfter.length;
  return e.charCount ?? Math.max(0, e.lengthHint ?? (e.posEnd - e.posStart));
}

export function buildOplog(normEvents, reliability) {
  const oplog = [];
  for (const e of normEvents) {
    if (!LENGTH_CHANGING_TYPES.has(e.type)) continue;
    if (reliability.get(e.id) !== 'position') continue;
    if (e.type === 'ai_interaction' || e.type === 'ai_suggestion') {
      if (!['fully_accepted', 'partially_accepted', 'modified'].includes(e.acceptance)) continue;
    }
    oplog.push({
      tsMs: e.tsMs,
      atPosition: e.posStart,
      deleted: e.posEnd - e.posStart,
      inserted: insertedLength(e),
      eventId: e.id,
    });
  }
  oplog.sort((a, b) => a.tsMs - b.tsMs);
  return oplog;
}

// Map a position recorded "as of just before `atTsMs`" forward to its
// corresponding position in the final document, by replaying every op that
// happened after it — the standard "transform a cursor across a later
// edit" rule from collaborative editing.
export function mapForward(pos, atTsMs, oplog) {
  let p = pos;
  let collapsed = false;
  for (const op of oplog) {
    if (op.tsMs <= atTsMs) continue; // only ops strictly later than this event
    if (p >= op.atPosition + op.deleted) {
      p += (op.inserted - op.deleted);
    } else if (p >= op.atPosition) {
      p = op.atPosition + op.inserted;
      collapsed = true;
    }
    // else: p < op.atPosition -> unaffected by this later op
  }
  return { pos: Math.max(0, p), collapsed };
}

// ── 5. Verification + fuzzy fallback ─────────────────────────────────────
function normalizeWs(s) {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

// Cheap normalized similarity in [0,1]; good enough to gate "close enough"
// without pulling in a full edit-distance library for short (<=500 char)
// snapshots.
function similarityRatio(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (long.includes(short)) return short.length / long.length;
  // Fallback: longest common substring ratio (cheap, not full Levenshtein).
  let best = 0;
  for (let i = 0; i < short.length; i++) {
    for (let len = short.length - i; len > best; len--) {
      if (long.includes(short.slice(i, i + len))) { best = len; break; }
    }
  }
  return best / long.length;
}

export function verify(finalText, start, end, snapshot) {
  if (!snapshot) return { ok: false };
  const actual = finalText.slice(start, end);
  const a = normalizeWs(actual);
  const s = normalizeWs(snapshot);
  if (a === s) return { ok: true, confidence: 'high' };
  const sim = similarityRatio(a, s);
  if (sim >= 0.85) return { ok: true, confidence: 'medium' };
  return { ok: false };
}

const escapeRe = (str) => str.split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');

// Adapted from the prior orphaned viewer's _fuzzyFind: ranked, whitespace-
// tolerant prefix search, disambiguated by proximity to a search-origin
// hint rather than always taking the first match in the document.
export function fuzzyLocate(finalText, needle, expectedLength, searchOriginHint, claimedRangesForNeedle) {
  const norm = normalizeWs(needle);
  if (!norm) return null;
  for (const prefixLen of [Math.min(norm.length, 80), 60, 40, 25, 15]) {
    if (prefixLen < 10) break;
    const prefix = norm.slice(0, prefixLen);
    let regex;
    try {
      regex = new RegExp(escapeRe(prefix), 'gi');
    } catch {
      continue;
    }
    const candidates = [];
    let m;
    while ((m = regex.exec(finalText)) !== null) {
      const start = m.index;
      const end = Math.min(finalText.length, start + (expectedLength || needle.length));
      const claimed = (claimedRangesForNeedle || []).some((r) => start < r.end && end > r.start);
      if (!claimed) candidates.push({ start, end });
      if (regex.lastIndex === m.index) regex.lastIndex++; // avoid infinite loop on zero-width match
    }
    if (!candidates.length) continue;
    const origin = searchOriginHint ?? 0;
    candidates.sort((x, y) => Math.abs(x.start - origin) - Math.abs(y.start - origin));
    return candidates[0];
  }
  return null;
}

// ── 6. Provenance range tracking ─────────────────────────────────────────
// Non-overlapping partition of [0, docLength) with per-range layer history.
export function createProvenanceRanges(docLength) {
  return [{ start: 0, end: docLength, history: [] }];
}

export function applyProvenance(ranges, start, end, layer) {
  if (start >= end) return;
  const overlapping = ranges.filter((r) => r.start < end && r.end > start);
  if (!overlapping.length) return;
  const replacement = [];
  for (const r of overlapping) {
    if (r.start < start) replacement.push({ start: r.start, end: start, history: r.history });
    const loStart = Math.max(r.start, start);
    const hiEnd = Math.min(r.end, end);
    if (loStart < hiEnd) replacement.push({ start: loStart, end: hiEnd, history: [...r.history, layer] });
    if (r.end > end) replacement.push({ start: end, end: r.end, history: r.history });
  }
  const firstIdx = ranges.indexOf(overlapping[0]);
  ranges.splice(firstIdx, overlapping.length, ...replacement);
  ranges.sort((a, b) => a.start - b.start);
  mergeAdjacent(ranges);
}

function mergeAdjacent(ranges) {
  for (let i = ranges.length - 2; i >= 0; i--) {
    const a = ranges[i], b = ranges[i + 1];
    if (a.end === b.start && historyEqual(a.history, b.history)) {
      a.end = b.end;
      ranges.splice(i + 1, 1);
    }
  }
}

function historyEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((l, i) => l.eventId === b[i].eventId);
}

// ── 7. Composite classification + tooltip text ───────────────────────────
export function classifyLayer(layer) {
  if (layer.type === 'edit_block' && layer.source === 'human') return 'human';
  if (layer.type === 'edit_block' && layer.source === 'external') return null; // superseded by the paired paste layer
  if (layer.type === 'paste') return 'paste';
  if (layer.type === 'ai_interaction' || layer.type === 'ai_suggestion') {
    return layer.acceptance === 'partially_accepted' ? 'ai-partial' : 'ai';
  }
  return null;
}

export function compositeKey(history) {
  const tags = [];
  for (const l of history) {
    const c = classifyLayer(l);
    if (c && tags[tags.length - 1] !== c) tags.push(c);
  }
  if (!tags.length) return 'human';
  return tags.join('-then-');
}

export function tooltipText(history) {
  const parts = history.map((l) => {
    const c = classifyLayer(l);
    if (c === 'ai') return `AI (${l.model ?? 'unknown model'})`;
    if (c === 'ai-partial') return `AI-suggested, partially kept (${l.model ?? 'unknown model'})`;
    if (c === 'paste') return `Pasted (${l.source ?? 'external'})`;
    if (c === 'human') return 'Edited by author';
    return null;
  }).filter(Boolean);
  return parts.join(' → ') || 'Original authorship';
}

export function cssClassFor(key) {
  const known = new Set(['human', 'paste', 'ai', 'ai-partial', 'ai-then-edited', 'paste-then-ai', 'human-then-ai']);
  if (known.has(key)) return `ann-${key}`;
  return 'ann-composite';
}

// ── 8. Top-level orchestration ────────────────────────────────────────────
export function computeAnnotations(xhtmlStr, log) {
  const dom = new DOMParser().parseFromString(xhtmlStr, 'text/html');
  // xhtmlStr is untrusted (a .twff file's content/document.xhtml can be
  // hand-crafted by anyone — this is a user-facing file-load feature, not a
  // Google-Docs-only path) — sanitize before any offset math runs, so every
  // downstream consumer (oplog, verify, fuzzyLocate, wrapRange) only ever
  // sees cleaned content. A no-op for real Google-Docs-exported XHTML.
  DOMPurify.sanitize(dom.body, { IN_PLACE: true });
  const { text: finalText, nodes, offsets } = linearizeDom(dom.body);
  const docLength = finalText.length;

  const rawEvents = Array.isArray(log?.events) ? log.events : [];
  const normEvents = rawEvents
    .map((raw, i) => normalizeEvent(raw, i))
    .filter((e) => e.type !== 'ignored')
    .sort((a, b) => a.tsMs - b.tsMs);

  // Running document-length estimate, used only to sanity-check (0,0) events.
  let docLenEstimate = 0;
  const reliability = new Map();
  for (const e of normEvents) {
    reliability.set(e.id, classifyReliability(e, docLenEstimate));
    if (LENGTH_CHANGING_TYPES.has(e.type) && reliability.get(e.id) !== 'none') {
      docLenEstimate += insertedLength(e) - (e.posEnd - e.posStart >= 0 ? (e.posEnd - e.posStart) : 0);
      docLenEstimate = Math.max(0, docLenEstimate);
    }
  }

  const oplog = buildOplog(normEvents, reliability);
  const ranges = createProvenanceRanges(docLength);
  const deletionLog = [];
  const supersededList = [];
  const unlocatedList = [];
  const claimedByNeedle = new Map();

  for (const e of normEvents) {
    if (!LENGTH_CHANGING_TYPES.has(e.type)) continue;
    if ((e.type === 'ai_interaction' || e.type === 'ai_suggestion')) {
      if (!['fully_accepted', 'partially_accepted', 'modified'].includes(e.acceptance)) continue; // Edge case 8
    }

    const snapshot = e.contentAfter ?? e.preview ?? null;
    const expectedLength = e.charCount ?? e.contentAfter?.length ?? (e.posEnd != null && e.posStart != null ? e.posEnd - e.posStart : null);
    let range = null;
    let locatedVia = null;

    const rel = reliability.get(e.id);
    if (rel === 'position') {
      const startMap = mapForward(e.posStart, e.tsMs, oplog);
      const endMap = mapForward(e.posEnd, e.tsMs, oplog);
      if (startMap.pos >= endMap.pos) {
        supersededList.push({ event: e, reason: 'content later fully deleted/overwritten' });
        continue;
      }
      const v = verify(finalText, startMap.pos, endMap.pos, snapshot);
      if (v.ok) {
        range = { start: startMap.pos, end: endMap.pos };
        locatedVia = 'offset';
      } else if (snapshot) {
        const needleList = claimedByNeedle.get(snapshot) ?? [];
        const found = fuzzyLocate(finalText, snapshot, expectedLength, startMap.pos, needleList);
        if (found) {
          range = found;
          locatedVia = 'fuzzy-after-offset-mismatch';
          claimedByNeedle.set(snapshot, [...needleList, found]);
        }
      }
    } else if (snapshot) {
      const needleList = claimedByNeedle.get(snapshot) ?? [];
      const originHint = unlocatedAwareOrigin(ranges, e);
      const found = fuzzyLocate(finalText, snapshot, expectedLength, originHint, needleList);
      if (found) {
        range = found;
        locatedVia = 'fuzzy';
        claimedByNeedle.set(snapshot, [...needleList, found]);
      }
    }

    if (!range) {
      unlocatedList.push({ event: e, reason: snapshot ? 'no matching text found in final document' : 'no snapshot text to search for' });
      continue;
    }

    applyProvenance(ranges, range.start, range.end, {
      eventId: e.id, timestamp: e.raw.timestamp, type: e.type, source: e.source,
      model: e.model, acceptance: e.acceptance, locatedVia,
    });
  }

  const annotatedFragment = buildAnnotatedFragment(dom, nodes, offsets, ranges);

  return {
    annotatedDom: annotatedFragment,
    provenanceRanges: ranges,
    deletionLog,
    supersededList,
    unlocatedList,
    stats: computeStats(normEvents, ranges, docLength),
  };
}

// Once a few events have been located, prefer searching near the end of the
// most recently located range rather than always defaulting to doc start —
// approximates chronological locality for events with no usable position at
// all (Edge case 5: disambiguating repeated short strings).
function unlocatedAwareOrigin(ranges, _e) {
  const tagged = ranges.filter((r) => r.history.length > 0);
  if (!tagged.length) return 0;
  return tagged[tagged.length - 1].end;
}

function computeStats(normEvents, ranges, docLength) {
  const wordCount = docLength ? Math.round(docLength / 5.5) : 0; // rough estimate, refined below if content available
  let editCount = 0, aiAccepted = 0, aiDismissed = 0, pasteCount = 0;
  for (const e of normEvents) {
    if (e.type === 'edit_block') editCount++;
    if (e.type === 'paste') pasteCount++;
    if (e.type === 'ai_interaction' || e.type === 'ai_suggestion') {
      if (['fully_accepted', 'partially_accepted', 'modified'].includes(e.acceptance)) aiAccepted++;
      else if (e.acceptance === 'rejected') aiDismissed++;
    }
  }
  let aiCoveragePct = 0, pasteCoveragePct = 0;
  for (const r of ranges) {
    const key = compositeKey(r.history);
    const span = r.end - r.start;
    if (key.startsWith('ai')) aiCoveragePct += span;
    if (key.includes('paste')) pasteCoveragePct += span;
  }
  if (docLength) {
    aiCoveragePct = Math.round((aiCoveragePct / docLength) * 100);
    pasteCoveragePct = Math.round((pasteCoveragePct / docLength) * 100);
  }
  return { wordCount, editCount, aiAccepted, aiDismissed, pasteCount, aiCoveragePct, pasteCoveragePct };
}

// ── DOM wrapping ──────────────────────────────────────────────────────────
// Splits and wraps text nodes in a detached DOM in-place; only ranges whose
// composite key isn't plain "human" get wrapped, to avoid wrapping the
// entire document in no-op spans.
function buildAnnotatedFragment(dom, nodes, offsets, ranges) {
  const taggedRanges = ranges.filter((r) => compositeKey(r.history) !== 'human');
  // Process in reverse document order so earlier wraps don't invalidate the
  // offsets table for ranges processed later.
  for (let i = taggedRanges.length - 1; i >= 0; i--) {
    const r = taggedRanges[i];
    wrapRange(dom, nodes, offsets, r.start, r.end, cssClassFor(compositeKey(r.history)), tooltipText(r.history));
  }
  return dom.body;
}

function wrapRange(dom, nodes, offsets, start, end, className, title) {
  const toWrap = [];
  for (let i = 0; i < nodes.length; i++) {
    const nodeStart = offsets[i];
    const nodeEnd = nodeStart + nodes[i].textContent.length;
    if (nodeEnd > start && nodeStart < end) {
      toWrap.push({
        node: nodes[i],
        sliceStart: Math.max(0, start - nodeStart),
        sliceEnd: Math.min(nodes[i].textContent.length, end - nodeStart),
      });
    }
  }
  for (let i = toWrap.length - 1; i >= 0; i--) {
    const { node, sliceStart, sliceEnd } = toWrap[i];
    const full = node.textContent;
    const before = full.slice(0, sliceStart);
    const mid = full.slice(sliceStart, sliceEnd);
    const after = full.slice(sliceEnd);
    if (!mid) continue;
    const parent = node.parentNode;
    if (!parent) continue;
    if (before) parent.insertBefore(dom.createTextNode(before), node);
    const span = dom.createElement('span');
    span.className = `ann ${className}`;
    if (title) span.title = title;
    span.textContent = mid;
    parent.insertBefore(span, node);
    if (after) parent.insertBefore(dom.createTextNode(after), node);
    parent.removeChild(node);
  }
}
