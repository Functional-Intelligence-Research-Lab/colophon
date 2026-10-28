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

  // True pre-truncation lengths (spec v0.2 §6.1's content_before_length/
  // content_after_length), when the producer supplied them — falls back to
  // the (possibly 500-char-capped) string's own length for older files that
  // predate this field, same as before.
  const contentBeforeLength = numOrNull(f.content_before_length) ?? (contentBefore != null ? contentBefore.length : null);
  const contentAfterLength = numOrNull(f.content_after_length) ?? (contentAfter != null ? contentAfter.length : null);

  const lengthHint =
    numOrNull(f.char_delta) ??
    (contentBeforeLength != null && contentAfterLength != null ? contentAfterLength - contentBeforeLength : null) ??
    (posStart != null && posEnd != null ? posEnd - posStart : null);

  return {
    id: `${index}:${raw.timestamp ?? ''}:${type}`,
    index,
    tsMs: Date.parse(raw.timestamp) || index, // fall back to index order if timestamp is unparseable
    type,
    source: f.source ?? null,
    source_tool: f.source_tool ?? null,
    source_tool_history: f.source_tool_history ?? null,
    model: f.model ?? null,
    acceptance: f.acceptance ?? null, // preserved verbatim, including the real producer's non-spec "pending"
    posStart, posEnd,
    contentBefore, contentAfter,
    contentBeforeLength, contentAfterLength,
    preview: f.output_preview ?? f.content_preview ?? null,
    charCount: numOrNull(f.char_count) ?? numOrNull(f.ai_chars),
    lengthHint,
    raw,
  };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Picks the text snapshot computeAnnotations() searches the final document
 * for, from an already-normalized event (see normalizeEvent() above).
 *
 * For paste events specifically, `contentAfter` (content_after) holds the
 * 300 characters of surrounding document context that followed the paste
 * (content.js's emitPaste()), never the pasted text itself — `preview`
 * (content_preview) is the field that actually holds it. Using
 * content_after as the match snapshot meant that once the real pasted text
 * was deleted but its trailing context survived untouched, the matcher
 * found that context and mislabeled it as still being the pasted content.
 * Every other length-changing event type's content_after IS the real
 * kept/generated text, so this only reorders the fallback for 'paste'.
 */
export function selectSnapshot(e) {
  return e.type === 'paste'
    ? (e.preview ?? e.contentAfter ?? null)
    : (e.contentAfter ?? e.preview ?? null);
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
    // branch used to match the known producer bug where position_end is
    // really a length, not an endpoint — but now that real edit_blocks can
    // also legitimately start at document position 0 and carry a verified
    // content_after, trust those too, the same way paste already is.
    if (e.type === 'paste' && e.charCount != null && (e.posEnd - e.posStart) === e.charCount) {
      return 'position';
    }
    if (e.contentAfterLength != null && Math.abs((e.posEnd - e.posStart) - e.contentAfterLength) <= 2) {
      return 'position';
    }
    return 'length-only';
  }
  // content_after for a paste is 300 characters of document text FOLLOWING
  // the paste, not the pasted text itself (unlike ai_interaction/
  // ai_suggestion/edit_block, where content_after really is the kept/
  // generated text) — so its length is never a valid sanity check for a
  // paste's real, accurate posStart/posEnd offset.
  if (e.type !== 'paste' && e.contentAfterLength != null
      && Math.abs((e.posEnd - e.posStart) - e.contentAfterLength) > 2) {
    return 'length-only';
  }
  return 'position';
}

// ── 4. Shift oplog + forward position mapping (drift correction) ────────
function insertedLength(e) {
  // Same content_after caveat as classifyReliability() above: for a paste,
  // content_after's length is trailing context, not the pasted text, so it
  // must never be preferred over the paste's own real charCount.
  if (e.type === 'paste') return e.charCount ?? Math.max(0, e.lengthHint ?? (e.posEnd - e.posStart));
  // Prefer the true pre-truncation length when the producer supplied one —
  // accurate even for insertions longer than the 500-char content cap,
  // since this field is a plain integer, not text, and isn't capped.
  if (e.contentAfterLength != null) return e.contentAfterLength;
  return e.charCount ?? Math.max(0, e.lengthHint ?? (e.posEnd - e.posStart));
}

// How many characters this event's edit REMOVED from the document -- a
// quantity entirely independent of posEnd-posStart. The producer defines
// position_end as prefixLen + addedRaw.length (see content.js's flushEdit),
// i.e. posEnd-posStart is always the INSERTED length, never the deleted
// one -- buildOplog() used to read deleted straight off that difference,
// which silently made every edit's net shift (inserted-deleted) collapse to
// zero regardless of whether it was an insertion, a deletion, or a
// different-length replacement. Only same-length replacements were ever
// correct by coincidence. content_before_length (when the producer supplied
// it) is the real, independent answer.
function deletedLength(e) {
  // A bare paste event has no content_before concept at all (not part of
  // its schema) -- its own posStart/posEnd describe where the INSERTED text
  // now sits, not anything removed. When a paste replaced a selection, that
  // real deleted amount only exists on its paired edit_block(source:
  // 'external') companion (see buildOplog()'s pairing de-dup below), so a
  // bare, unpaired paste is safest treated as a pure insertion.
  if (e.type === 'paste') return 0;
  if (e.contentBeforeLength != null) return e.contentBeforeLength;
  // No true length available (older producer output) -- 0 is a neutral,
  // honest "unknown, assume nothing was removed" rather than reintroducing
  // the old posEnd-posStart bug (which always equals insertedLength and so
  // always zeroed out the net shift, even for pure insertions/deletions).
  return 0;
}

export function buildOplog(normEvents, reliability) {
  // A clipboard paste paired with its spec-mandated companion
  // edit_block(source:'external') at the same timestamp (see
  // classifyLayer()'s 'external' case) describes the exact same physical
  // edit twice. The edit_block carries the more reliable
  // content_before_length/content_after_length, so once a pairing exists,
  // only it should contribute a drift op -- otherwise the same insertion
  // gets counted twice and later events get shifted by roughly double the
  // real paste length. Older files with no paired edit_block (the producer
  // gap this is matched against) still get drift correction from the paste
  // event alone, unaffected.
  const pairedExternalTsMs = new Set(
    normEvents.filter((e) => e.type === 'edit_block' && e.source === 'external').map((e) => e.tsMs)
  );
  const oplog = [];
  for (const e of normEvents) {
    if (!LENGTH_CHANGING_TYPES.has(e.type)) continue;
    if (e.type === 'paste' && pairedExternalTsMs.has(e.tsMs)) continue;
    if (reliability.get(e.id) !== 'position') continue;
    if (e.type === 'ai_interaction' || e.type === 'ai_suggestion') {
      if (!['fully_accepted', 'partially_accepted', 'modified'].includes(e.acceptance)) continue;
    }
    oplog.push({
      tsMs: e.tsMs,
      atPosition: e.posStart,
      deleted: deletedLength(e),
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

// Fraction of the needle's own length two candidates' distance-to-origin
// must differ by before the better one is trusted over the other — a
// frozen, documented constant (not a loose heuristic) so "ambiguous" is a
// deterministic outcome, not a judgment call made differently each time.
// Below this margin, two (or more) candidates are genuinely too close to
// call, and NEITHER is silently chosen.
export const AMBIGUITY_MARGIN_FRACTION = 0.20;

// Adapted from the prior orphaned viewer's _fuzzyFind: ranked, whitespace-
// tolerant prefix search, disambiguated by proximity to a search-origin
// hint rather than always taking the first match in the document.
//
// Returns one of three shapes:
//   null                                        — no candidate at all (unlocated)
//   { ambiguous: true, candidates }              — 2+ candidates too close to call; NEVER resolved to one
//   { start, end, confidence: 'high'|'medium' }  — a single, confidently-chosen match
//
// Confidence depends on WHICH prefix tier produced the match, not just
// candidate count: `tier 0` (the full needle, up to the 80-char cap) is a
// genuinely full-text match — a single candidate there is 'high'. Every
// shorter fallback tier (60/40/25/15 chars) is matching only a PIECE of the
// needle, inherently less reliable even with exactly one candidate — those
// are 'medium'. Distance-to-origin alone was never a safe disambiguator for
// repeated phrases (the exact case this exists to catch); candidates are
// now also scored by which tier found them, and the ambiguity check
// compares same-tier candidates jointly with distance.
export function fuzzyLocate(finalText, needle, expectedLength, searchOriginHint, claimedRangesForNeedle) {
  const norm = normalizeWs(needle);
  if (!norm) return null;
  // The first candidate is the full needle itself (or its 80-char cap). It must
  // always be tried, even when the needle is under 10 characters: matching an
  // entire short string exactly is far less ambiguous than matching an
  // arbitrary short substring of a longer one, which is what the 10-char floor
  // below is actually guarding against for the *shrinking* fallback prefixes.
  const prefixLens = [Math.min(norm.length, 80), 60, 40, 25, 15];
  for (let i = 0; i < prefixLens.length; i++) {
    const prefixLen = prefixLens[i];
    if (i > 0 && prefixLen < 10) break;
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

    if (candidates.length >= 2) {
      const bestDist = Math.abs(candidates[0].start - origin);
      const secondDist = Math.abs(candidates[1].start - origin);
      const margin = norm.length * AMBIGUITY_MARGIN_FRACTION;
      if (secondDist - bestDist < margin) {
        // Two or more real candidates at this SAME tier, too close to call
        // — never silently resolved to one. All candidates within the
        // margin of the best are reported, not just the top two, so the
        // caller can list every genuinely-live option.
        const withinMargin = candidates.filter(
          (c) => Math.abs(c.start - origin) - bestDist < margin
        );
        return { ambiguous: true, candidates: withinMargin };
      }
    }

    const confidence = (i === 0 && candidates.length === 1) ? 'high' : 'medium';
    return { start: candidates[0].start, end: candidates[0].end, confidence, ambiguous: false };
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
  // 'not_ai' is itself a self-report -- the student affirmatively said this
  // paste ISN'T AI-generated, so it must stay plain 'paste', not flip the
  // honest "not AI" tag into an AI-disclosure label.
  if (layer.type === 'paste' && layer.source_tool && layer.source_tool !== 'not_ai') return 'paste-ai-disclosed';
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

// Plain-language name for how a range's CURRENT (most recent) layer was
// located — part of the two-dimensional model (what was observed × how
// certain is the placement): this is the "how certain" half, stated as
// text so it survives print/PDF export and screen readers, not just a
// hover color. Mirrors fuzzyLocate()'s/verify()'s own locatedVia/
// confidence vocabulary.
export function certaintyText(locatedVia, confidence) {
  if (confidence === 'high' && locatedVia === 'offset') return 'exact position match';
  if (confidence === 'high') return 'exact text match';
  if (confidence === 'medium' && locatedVia === 'offset') return 'inferred — position recorded but text only approximately matched; review';
  if (confidence === 'medium') return 'inferred by text similarity; review';
  return null;
}

export function tooltipText(history) {
  const parts = history.map((l) => {
    const c = classifyLayer(l);
    if (c === 'ai') return `AI (${l.model ?? 'unknown model'})`;
    if (c === 'ai-partial') return `AI-suggested, partially kept (${l.model ?? 'unknown model'})`;
    if (c === 'paste-ai-disclosed') {
      const label = `AI-generated content (self-reported: ${l.source_tool})`;
      // "Was this corrected" is always derived from history length, never a
      // separate flag that could drift out of sync with the array itself.
      if (l.source_tool_history?.length > 1) {
        return `${label}, corrected from ${l.source_tool_history[0].value}`;
      }
      return label;
    }
    if (c === 'paste') return `Pasted (${l.source ?? 'external'})`;
    if (c === 'human') return 'Edited by author';
    return null;
  }).filter(Boolean);
  const base = parts.join(' → ') || 'Original authorship';
  // Only the LAST (current) layer's certainty is relevant to display — a
  // prior, superseded layer's own confidence isn't what the reader is
  // looking at now. A plain 'human' range (no history at all) has no
  // event-location concept, so no certainty line is added.
  const current = history[history.length - 1];
  const certainty = current ? certaintyText(current.locatedVia, current.confidence) : null;
  return certainty ? `${base} (${certainty})` : base;
}

export function cssClassFor(key, confidence) {
  // compositeKey() can never actually produce 'ai-then-edited' (classifyLayer
  // only ever tags a layer 'human', never 'edited') -- AI-content-later-
  // edited-by-hand always composites to 'ai-then-human', which this set
  // used to be missing entirely, silently falling through to the generic
  // 'ann-composite' for one of the most important histories this product
  // exists to show. 'paste-then-human' (pasted content later typed over) is
  // the other common case worth its own label, not the generic fallback.
  const known = new Set(['human', 'paste', 'paste-ai-disclosed', 'ai', 'ai-partial', 'ai-then-human', 'paste-then-ai', 'human-then-ai', 'paste-then-human']);
  const base = known.has(key) ? `ann-${key}` : 'ann-composite';
  // Certainty is a SEPARATE visual dimension from provenance-type color
  // (ann-ai/ann-paste/etc.) — a second class, not a swap, so the two
  // layer independently (viewer.css: a dashed/patterned border, not a
  // different fill color). 'high' confidence (or no confidence concept at
  // all, e.g. the plain 'human' baseline) gets no modifier — the existing,
  // unmodified look already means "placed with confidence."
  return confidence === 'medium' ? `${base} ann-certainty-inferred` : base;
}

// ── 8. Top-level orchestration ────────────────────────────────────────────
export function computeAnnotations(xhtmlStr, log) {
  // xhtmlStr is untrusted (a .twff file's content/document.xhtml can be
  // hand-crafted by anyone — this is a user-facing file-load feature, not a
  // Google-Docs-only path) — sanitize the raw STRING before it's ever
  // parsed into a DOM, not the parsed DOM afterward: parsing untrusted
  // markup first and sanitizing in-place after is the exact mutation-XSS
  // (mXSS) pattern DOMPurify's own docs warn against, and ported the
  // weaker default allowlist along with it (colophon-web's copy already
  // had this fixed — this file hadn't been, confirmed by the two copies'
  // drift-detector test, colophon-web/tests/test_annotate_js_parity.py).
  const safeHtml = DOMPurify.sanitize(xhtmlStr, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'],
    ALLOW_DATA_ATTR: false,
  });
  const dom = new DOMParser().parseFromString(safeHtml, 'text/html');
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
      docLenEstimate += insertedLength(e) - deletedLength(e);
      docLenEstimate = Math.max(0, docLenEstimate);
    }
  }

  const oplog = buildOplog(normEvents, reliability);
  const ranges = createProvenanceRanges(docLength);
  const deletionLog = [];
  const supersededList = [];
  const unlocatedList = [];
  // Ambiguous matches NEVER become a provenance range (never auto-picked,
  // never drawn as if confirmed) — they only ever live here, as their own
  // explicit evidence-list entry naming every candidate location.
  const ambiguousList = [];
  const claimedByNeedle = new Map();

  for (const e of normEvents) {
    if (!LENGTH_CHANGING_TYPES.has(e.type)) continue;
    if ((e.type === 'ai_interaction' || e.type === 'ai_suggestion')) {
      if (!['fully_accepted', 'partially_accepted', 'modified'].includes(e.acceptance)) continue; // Edge case 8
    }

    const snapshot = selectSnapshot(e);
    const expectedLength = e.charCount ?? e.contentAfterLength ?? (e.posEnd != null && e.posStart != null ? e.posEnd - e.posStart : null);
    let range = null;
    let locatedVia = null;
    let confidence = null;
    let wasAmbiguous = false;

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
        confidence = v.confidence; // 'high' (exact) or 'medium' (>=0.85 similarity at the claimed position)
      } else if (snapshot) {
        const needleList = claimedByNeedle.get(snapshot) ?? [];
        const found = fuzzyLocate(finalText, snapshot, expectedLength, startMap.pos, needleList);
        if (found?.ambiguous) {
          wasAmbiguous = true;
          ambiguousList.push({ event: e, candidates: found.candidates, reason: 'ambiguous-match' });
        } else if (found) {
          range = found;
          locatedVia = 'fuzzy-after-offset-mismatch';
          confidence = found.confidence;
          claimedByNeedle.set(snapshot, [...needleList, found]);
        }
      }
    } else if (snapshot) {
      const needleList = claimedByNeedle.get(snapshot) ?? [];
      const originHint = unlocatedAwareOrigin(ranges, e);
      const found = fuzzyLocate(finalText, snapshot, expectedLength, originHint, needleList);
      if (found?.ambiguous) {
        wasAmbiguous = true;
        ambiguousList.push({ event: e, candidates: found.candidates, reason: 'ambiguous-match' });
      } else if (found) {
        range = found;
        locatedVia = 'fuzzy';
        confidence = found.confidence;
        claimedByNeedle.set(snapshot, [...needleList, found]);
      }
    }

    if (wasAmbiguous) continue;

    if (!range) {
      unlocatedList.push({ event: e, reason: snapshot ? 'unlocated-no-match' : 'unlocated-no-snapshot' });
      continue;
    }

    applyProvenance(ranges, range.start, range.end, {
      eventId: e.id, timestamp: e.raw.timestamp, type: e.type, source: e.source,
      model: e.model, acceptance: e.acceptance, locatedVia, confidence,
      source_tool: e.source_tool, source_tool_history: e.source_tool_history,
    });
  }

  const annotatedFragment = buildAnnotatedFragment(dom, nodes, offsets, ranges);

  return {
    annotatedDom: annotatedFragment,
    provenanceRanges: ranges,
    deletionLog,
    supersededList,
    unlocatedList,
    ambiguousList,
    stats: computeStats(normEvents, ranges, docLength, unlocatedList, ambiguousList),
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

// Best-known character magnitude for an event with no confirmed location --
// the same fallback chain insertedLength() uses for located events, since an
// unlocated event has exactly the same fields available, just nothing to
// verify them against.
function bestKnownCharMagnitude(e) {
  return e.charCount ?? e.contentAfterLength ?? Math.abs(e.lengthHint ?? 0);
}

export function computeStats(normEvents, ranges, docLength, unlocatedList, ambiguousList) {
  const wordCount = docLength ? Math.round(docLength / 5.5) : 0; // rough estimate, refined below if content available
  let editCount = 0, aiAccepted = 0, aiDismissed = 0, pasteCount = 0;
  for (const e of normEvents) {
    // An edit_block(source:'external') is the paired companion a paste now
    // emits alongside itself (TWFF spec's paste/edit_block pairing
    // requirement) -- plumbing that lets the position-drift math reuse the
    // same verified-content machinery as human edits, not a reader-facing
    // "edit" of its own. Counting it would inflate "Edits" by one per
    // paste, double-counting the exact same action the paste event already
    // represents.
    if (e.type === 'edit_block' && e.source !== 'external') editCount++;
    if (e.type === 'paste') pasteCount++;
    if (e.type === 'ai_interaction' || e.type === 'ai_suggestion') {
      if (['fully_accepted', 'partially_accepted', 'modified'].includes(e.acceptance)) aiAccepted++;
      else if (e.acceptance === 'rejected') aiDismissed++;
    }
  }

  // Confidence changes what counts toward the EXACT point estimate, not
  // just how a range is drawn: only 'high'-confidence ranges (the current/
  // most-recent layer touching that span, matching what's actually there
  // now) count toward aiCoveragePct/pasteCoveragePct directly. 'medium'
  // (genuinely placed, but inferred rather than verified exactly) widens
  // the uncertainty range below instead of inflating the headline number.
  let aiCoveragePct = 0, pasteCoveragePct = 0;
  let aiMediumChars = 0, pasteMediumChars = 0;
  for (const r of ranges) {
    const key = compositeKey(r.history);
    const span = r.end - r.start;
    const currentConfidence = r.history.length ? r.history[r.history.length - 1].confidence : null;
    // paste-ai-disclosed is self-reported AI content, not independently
    // observed/generated the way 'ai'/'ai-partial' are — but it's still AI
    // content, and must count toward the AI-coverage stat, not just the
    // paste-coverage one (its key starts with "paste", not "ai", purely as
    // a classification-key naming artifact).
    const isAi = key.startsWith('ai') || key.includes('paste-ai-disclosed');
    const isPaste = key.includes('paste');
    if (currentConfidence === 'medium') {
      if (isAi) aiMediumChars += span;
      if (isPaste) pasteMediumChars += span;
      continue; // not in the exact point estimate
    }
    if (isAi) aiCoveragePct += span;
    if (isPaste) pasteCoveragePct += span;
  }
  if (docLength) {
    aiCoveragePct = Math.round((aiCoveragePct / docLength) * 100);
    pasteCoveragePct = Math.round((pasteCoveragePct / docLength) * 100);
  }

  // Bounded-uncertainty range: an event the engine couldn't locate (no
  // confirmed position in the final document) contributes NOTHING to the
  // coverage sums above -- the text it touched silently keeps whatever an
  // earlier, already-located layer said, with no numeric trace. That's
  // fine when nothing was unlocated, but presenting aiCoveragePct/
  // pasteCoveragePct as flat, single numbers while real editing activity
  // went untracked overstates how much this report actually knows. Each
  // unlocated event's TYPE is still known even when its location isn't, so
  // the direction of its possible effect is known even without knowing
  // exactly where: a human edit can only ever have REPLACED ai/paste text
  // (pulling both coverages down), never added more of it; an accepted AI
  // interaction or a paste can only ever have ADDED to its own coverage
  // (pulling it up), never erased a human-written span. See the header
  // comment on computeAnnotations() -- this never touches buildOplog()'s
  // own 'position'-only filter, it only widens how the final two
  // percentages are reported. Ambiguous matches widen it the same
  // direction as unlocated (their true location, and therefore effect, is
  // just as unknown) -- 'high'-confidence ranges only, which is why
  // mediumChars gets its own separate addition on the Max side.
  let humanUntrackedChars = 0, aiUntrackedChars = 0, pasteUntrackedChars = 0, pasteAiDisclosedUntrackedChars = 0;
  for (const u of unlocatedList ?? []) {
    const e = u.event;
    const chars = bestKnownCharMagnitude(e);
    if (chars <= 0) continue;
    if (e.type === 'edit_block' && e.source === 'human') {
      humanUntrackedChars += chars;
    } else if ((e.type === 'ai_interaction' || e.type === 'ai_suggestion')
        && ['fully_accepted', 'partially_accepted', 'modified'].includes(e.acceptance)) {
      aiUntrackedChars += chars;
    } else if (e.type === 'paste') {
      if (e.source_tool && e.source_tool !== 'not_ai') pasteAiDisclosedUntrackedChars += chars;
      else pasteUntrackedChars += chars;
    }
  }
  for (const a of ambiguousList ?? []) {
    const e = a.event;
    const chars = bestKnownCharMagnitude(e);
    if (chars <= 0) continue;
    if ((e.type === 'ai_interaction' || e.type === 'ai_suggestion')
        && ['fully_accepted', 'partially_accepted', 'modified'].includes(e.acceptance)) {
      aiUntrackedChars += chars;
    } else if (e.type === 'paste') {
      if (e.source_tool && e.source_tool !== 'not_ai') pasteAiDisclosedUntrackedChars += chars;
      else pasteUntrackedChars += chars;
    }
  }
  const untrackedChars = humanUntrackedChars + aiUntrackedChars + pasteUntrackedChars + pasteAiDisclosedUntrackedChars;
  const pct = (chars) => (docLength ? Math.round((chars / docLength) * 100) : 0);
  const clamp = (n) => Math.max(0, Math.min(100, n));
  const pasteCoverageMin = clamp(pasteCoveragePct - pct(humanUntrackedChars));
  const pasteCoverageMax = clamp(pasteCoveragePct + pct(pasteUntrackedChars) + pct(pasteAiDisclosedUntrackedChars) + pct(pasteMediumChars));
  const aiCoverageMin = clamp(aiCoveragePct - pct(humanUntrackedChars));
  const aiCoverageMax = clamp(aiCoveragePct + pct(aiUntrackedChars) + pct(pasteAiDisclosedUntrackedChars) + pct(aiMediumChars));

  // Per-event evidence summary -- "N recorded, X placed exactly, Y inferred,
  // Z ambiguous, W couldn't be placed" -- built from counts, not prose; the
  // viewer composes the actual sentence from these.
  let placedExact = 0, placedInferred = 0;
  for (const r of ranges) {
    if (!r.history.length) continue;
    const confidence = r.history[r.history.length - 1].confidence;
    if (confidence === 'high') placedExact++;
    else if (confidence === 'medium') placedInferred++;
  }

  return {
    wordCount, editCount, aiAccepted, aiDismissed, pasteCount, aiCoveragePct, pasteCoveragePct,
    pasteCoverageMin, pasteCoverageMax, aiCoverageMin, aiCoverageMax,
    untrackedChars, untrackedCount: (unlocatedList ?? []).length,
    ambiguousCount: (ambiguousList ?? []).length,
    evidenceSummary: {
      placedExact, placedInferred,
      ambiguous: (ambiguousList ?? []).length,
      unlocated: (unlocatedList ?? []).length,
    },
  };
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
    const currentConfidence = r.history.length ? r.history[r.history.length - 1].confidence : null;
    wrapRange(
      dom, nodes, offsets, r.start, r.end,
      cssClassFor(compositeKey(r.history), currentConfidence),
      tooltipText(r.history),
    );
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
