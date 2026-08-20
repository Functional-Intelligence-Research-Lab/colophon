/**
 * gemini-selectors.js — Centralised matchers for Google Docs' native Gemini UI
 *
 * Why this file exists
 * --------------------
 * Google ships the "Help me write" / "Refine" Gemini UI as ordinary HTML DOM
 * (a popover overlaid on the canvas-rendered document), but the class names are
 * obfuscated and rotate frequently — extensions that hardcode them break every
 * time Google reshuffles the build. To stay robust *and* maintainable we:
 *
 *   1. Detect by SEMANTICS first — ARIA roles and accessible (user-visible)
 *      button text, which track the product's behaviour and change far less
 *      often than hashed class names.
 *   2. Keep hashed CLASS names only as a secondary fallback, all in this one
 *      file, so a Google change is a localised edit here — never a hunt through
 *      detection logic.
 *
 * When Gemini detection silently stops working, this file is the first and
 * usually only place to update. See content.js `watchGeminiUI()` for usage and
 * the health-check that surfaces breakage instead of failing silently.
 *
 * Long-term upgrade path: the truly UI-independent approach is to intercept the
 * Gemini network response in the page's MAIN world. This module is deliberately
 * the seam for that — a future `gemini-network.js` can feed the same emit()
 * helpers without touching the rest of content.js.
 */

/**
 * Accessible names (button labels / aria-labels) that indicate the user is
 * ACCEPTING a Gemini suggestion into the document. Matched case-insensitively
 * against trimmed text content and aria-label. User-facing strings change
 * rarely and are localised, so we match on these primarily but keep the set
 * small and specific to avoid false positives.
 */
export const ACCEPT_LABELS = [
  'insert',
  'replace',
  'accept',
  'accept all',
  'accept suggestion',
]

/**
 * Accessible names that indicate the user is REJECTING / dismissing a Gemini
 * suggestion without keeping its text.
 */
export const REJECT_LABELS = [
  'close',
  'cancel',
  'discard',
  'reject',
  'reject all',
  'recreate', // throws the current draft away to generate a new one
]

/**
 * Accessible names for the "generate / try again" affordances. Not an
 * acceptance signal on their own, but useful to recognise the Gemini surface.
 */
export const REFINE_LABELS = [
  'refine',
  'rephrase',
  'regenerate',
  'try again',
  'create',
  'recreate',
]

/**
 * SEMANTIC matchers for the Gemini suggestion container (the popover/dialog
 * holding the generated draft + action buttons). Tried in order; the first to
 * match wins. Structure/role selectors come before hashed-class selectors so we
 * survive class rotation.
 *
 * NOTE: the class-based entries are best-effort fallbacks captured from
 * community sources (see PR notes) and WILL drift. Treat a class-only match as
 * lower-confidence than a semantic match.
 */
export const SUGGESTION_CONTAINER_SELECTORS = [
  // Barkick response area — checked first because it is the primary surface.
  '.appsElementsSidekickBarkickTopBox',

  // Anchored canvas diff containers (the inline checkmark / cross buttons overlay next to document text)
  '.docos-anchoreddocoview',
  '.docosAiPreviewDiffVisibleSuggestionViewContent',
  '.docos-docoview-tesla-conflict',

  // Semantic selectors for the classic "Help me write" popover.
  '[role="dialog"]',
  '[role="region"][aria-label*="Gemini" i]',
  '[aria-label*="Help me write" i]',

  // Class-based fallbacks (obfuscated, expected to drift over time).
  '.docs-gm-promo-container',
  '#docs-instant-bubble',    // "Refine" bubble shown on a text selection
]

/**
 * Selectors that, on their own, mark the presence of Gemini entry points in the
 * document chrome. Used by the health-check to decide whether Gemini was
 * *available* in a session (so we can flag "available but never detected").
 */
export const GEMINI_PRESENCE_SELECTORS = [
  '.appsElementsSidekickEntryPointRoot', // "Ask Gemini" side-panel entry button
  '.kixWizBarkickContainer',             // bottom Gemini bar (was .kixWizBarkickWrapper — drifted)
  '.docos-anchoreddocoview',
  '[aria-label*="Gemini" i]',
]

/**
 * Heuristic: does this element (or its accessible name) read as a Gemini accept
 * action? Centralised so content.js never inlines label strings.
 */
export function classifyAction(el) {
  if (!el) return null
  if (el.classList?.contains('docosAiPreviewDiffVisibleSuggestionViewAcceptButton')) return 'accept'
  if (el.classList?.contains('docosAiPreviewDiffVisibleSuggestionViewRejectButton')) return 'reject'
  const actionType = el.getAttribute?.('data-action-type')
  if (actionType === '44' || el.classList?.contains('appsElementsSidekickResponseOptionsActionBarButtonPrimary')) return 'accept'
  if (actionType === '45' || el.classList?.contains('appsElementsSidekickResponseOptionsActionBarButtonSecondary')) return 'reject'
  const name = accessibleName(el)
  if (!name) return null
  if (matchesAny(name, ACCEPT_LABELS) || name.startsWith('accept') || name.startsWith('insert') || name.startsWith('replace')) return 'accept'
  if (matchesAny(name, REJECT_LABELS) || name.startsWith('reject') || name.startsWith('discard') || name.startsWith('close')) return 'reject'
  return null
}

/**
 * Best-effort accessible name for an element: aria-label, then trimmed text.
 * Lower-cased and whitespace-collapsed for stable matching.
 */
export function accessibleName(el) {
  const aria = el.getAttribute?.('aria-label') ?? ''
  const text = el.textContent ?? ''
  return (aria || text).trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * True when `name` exactly equals (not merely contains) one of `labels`.
 * Exact match keeps "close" from matching "disclose", etc. Buttons whose label
 * is e.g. "Insert" still match because we compare the whole accessible name.
 */
export function matchesAny(name, labels) {
  return labels.includes(name)
}

/** First matching suggestion-container element in `root`, or null. */
export function findSuggestionContainer(root = document) {
  for (const sel of SUGGESTION_CONTAINER_SELECTORS) {
    let el = null
    try {
      el = root.querySelector(sel)
    } catch {
      // Bad/unsupported selector — skip rather than throw.
      continue
    }
    if (el && looksLikeGeminiSuggestion(el)) return el
  }
  return null
}

/**
 * Guard against false positives from generic `[role="dialog"]` matches: only
 * treat a container as a Gemini suggestion if it actually holds an accept/refine
 * affordance or a Gemini reference. Keeps non-Gemini Docs dialogs out.
 */
export function looksLikeGeminiSuggestion(container) {
  if (!container) return false

  // To avoid false positives from empty prompt boxes, settings dialogs, or 
  // the initial "Refine" options menu, the container must have an "accept" button 
  // (e.g. Insert, Replace, Accept, or checkmark) indicating a suggestion is ready to be applied.
  const buttons = container.querySelectorAll?.('button, [role="button"], .docosAiPreviewDiffVisibleSuggestionViewAcceptButton, .appsElementsSidekickResponseOptionsActionBarButtonPrimary') ?? []
  let hasAccept = false
  for (const b of buttons) {
    if (classifyAction(b) === 'accept') {
      hasAccept = true
      break
    }
  }
  if (!hasAccept) return false

  if (container.classList?.contains('appsElementsSidekickBarkickTopBox') ||
      container.classList?.contains('docos-anchoreddocoview') ||
      container.classList?.contains('docosAiPreviewDiffVisibleSuggestionViewContent') ||
      container.querySelector?.('.docosAiPreviewDiffVisibleSuggestionViewAcceptButton') ||
      container.querySelector?.('.appsElementsSidekickBarkickTopBoxResponseOneSystem') ||
      container.querySelector?.('.appsElementsSidekickBarkickTopBoxResponseTextOneSystem') ||
      container.querySelector?.('.appsElementsSidekickBarkickSparkIconContainer')) {
    return true
  }
  const name = accessibleName(container)
  if (name.includes('help me write')) return true
  for (const b of buttons) {
    const bn = accessibleName(b)
    if (matchesAny(bn, ACCEPT_LABELS) || matchesAny(bn, REFINE_LABELS) || bn.startsWith('accept') || bn.startsWith('reject')) return true
  }
  return false
}

/** True if any Gemini entry point is present in the document chrome. */
export function geminiAvailable(root = document) {
  return GEMINI_PRESENCE_SELECTORS.some(sel => {
    try {
      return !!root.querySelector(sel)
    } catch {
      return false
    }
  })
}

/** Stable provider identifier for emitted TWFF events. */
export const GEMINI_MODEL_ID = 'google/gemini'

export function isMetaCommentary(text) {
  if (!text) return true;
  const lower = text.toLowerCase().trim();
  if (lower.startsWith('{') || lower.startsWith('[')) return true;
  return [
    "i've updated",
    "i updated",
    "i've rewritten",
    "i rewritten",
    "i've revised",
    "i revised",
    "i've expanded",
    "i expanded",
    "i've added",
    "i added",
    "i've modified",
    "i modified",
    'the selected text is not provided',
    'please provide the text',
    "i don't have",
    "i'm unable",
    "i'm sorry",
    'as an ai',
    'as a language model',
    'as an assistant',
    'i cannot',
    'i need more context',
    'could you please provide',
    "the user's writing is",
    "the user's text is",
    'the user wants me to',
    'treat everything before',
    '[cursor]',
  ].some(p => lower.includes(p));
}

/**
 * Strips leading sentences/lines that are Gemini commentary about what it did
 * ("I've updated the document to be more concise. Here is the revised text:"),
 * leaving only the actual generated content that follows.
 *
 * If the entire text is commentary, or if no content lines are found, the
 * original text is returned unchanged so the caller can still show something.
 */
export function stripMetaLines(text) {
  if (!text) return text;

  // Pattern: a line that starts with a first-person meta-statement.
  const META_LINE = /^(i('ve| have|'m)\s|here\s(is|are|'s)\s(the\s)?(revised|updated|rewritten|new|full|corrected)|this\s(is|version)|below\s(is|you|are)|the\s(following|text|document|passage)|sure[,!]?\s|certainly[,!]?\s|of course[,!]?\s)/i;

  const lines = text.split('\n');
  // Find the first line that does NOT look like meta-commentary.
  const firstContentIdx = lines.findIndex(l => {
    const t = l.trim();
    return t.length > 0 && !META_LINE.test(t) && !isMetaCommentary(t);
  });

  if (firstContentIdx <= 0) return text; // nothing to strip, or all content
  const stripped = lines.slice(firstContentIdx).join('\n').trim();
  return stripped.length > 20 ? stripped : text; // safety: keep original if result is suspiciously short
}

export function extractGeminiProposedDiff(root = document) {
  let insertedText = '';
  let deletedText = '';

  console.log('[Colophon Canvas Inspection] Starting suggestion diff extraction...');

  // ── Strategy 1: explicit tracked-change / suggestion DOM elements ────────────
  // These exist when Docs renders suggestions in "Suggesting" mode.
  const insertEls = Array.from(root.querySelectorAll(
    '.kix-tracked-change-insert, .kix-suggestion-overlay-insert, .docos-suggestion-insert, [data-suggestion-type="insert"], .docos-suggestion-view-insert'
  ));
  const deleteEls = Array.from(root.querySelectorAll(
    '.kix-tracked-change-delete, .kix-suggestion-overlay-delete, .docos-suggestion-delete, [data-suggestion-type="delete"], .docos-suggestion-view-delete'
  ));

  if (insertEls.length > 0) {
    console.log('[Colophon Canvas Inspection] Explicit insert elements:', insertEls.map(e => e.textContent));
    insertedText = insertEls.map(e => e.textContent).join(' ').trim();
  }
  if (deleteEls.length > 0) {
    console.log('[Colophon Canvas Inspection] Explicit delete elements:', deleteEls.map(e => e.textContent));
    deletedText = deleteEls.map(e => e.textContent).join(' ').trim();
  }

  // ── Strategy 2: docos-anchoreddocoview inline diff cards ────────────────────
  // When Gemini proposes changes in "Help me write" mode, it inserts inline
  // diff cards next to the changed text containing the proposed text.
  // These cards are NOT inside canvas — they are real HTML overlays.
  if (!insertedText) {
    const diffCards = Array.from(root.querySelectorAll(
      '.docos-anchoreddocoview .docosAiPreviewDiffVisibleSuggestionViewContent, .docos-docoview-tesla-conflict .docosAiPreviewDiffVisibleSuggestionViewContent'
    ));
    if (diffCards.length > 0) {
      // Clone to avoid grabbing the accept/reject button text
      const cardTexts = diffCards.map(card => {
        const clone = card.cloneNode(true);
        // Remove action buttons from the clone
        clone.querySelectorAll('button, [role="button"], .docosAiPreviewDiffVisibleSuggestionViewAcceptButton, .docosAiPreviewDiffVisibleSuggestionViewRejectButton').forEach(b => b.remove());
        return clone.textContent.trim();
      }).filter(t => t.length > 2);
      if (cardTexts.length > 0) {
        insertedText = cardTexts.join(' ');
        console.log('[Colophon Canvas Inspection] Diff card text extracted:', insertedText);
      }
    }
  }

  // ── Strategy 3: Barkick sidebar response text ────────────────────────────────
  // The Gemini sidebar shows what it generated as readable DOM text. We try all
  // known container selectors (they drift over time) and strip any leading
  // meta-commentary lines ("I've updated the document...") so only the actual
  // generated content is captured.
  if (!insertedText) {
    const SIDEBAR_SELECTORS = [
      '.appsElementsSidekickBarkickTopBoxResponseOneSystem',
      '.appsElementsSidekickBarkickTopBoxResponseTextOneSystem',
      '.appsElementsSidekickBarkickTopBoxResponseContainerOneSystem',
      '.appsElementsGenerativeaiAstAnimated',
    ];
    for (const sel of SIDEBAR_SELECTORS) {
      const el = root.querySelector(sel);
      if (!el) continue;

      // Clone and strip interactive controls so we only capture prose.
      const clone = el.cloneNode(true);
      clone.querySelectorAll('button, [role="button"], textarea, input').forEach(n => n.remove());
      const raw = clone.textContent?.trim() ?? '';

      if (raw.length > 10) {
        // Strip leading meta-commentary lines before the actual generated text.
        const cleaned = stripMetaLines(raw);
        console.log('[Colophon Canvas Inspection] Sidebar response text (cleaned):', cleaned.slice(0, 80));
        insertedText = cleaned;
        break;
      }
    }
  }

  console.log('[Colophon Canvas Inspection] Final result:', { insertedText: insertedText.slice(0, 80), deletedText: deletedText.slice(0, 80) });
  return { insertedText, deletedText };
}
