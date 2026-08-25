/**
 * block-insertion.js — Detect text that appears in a single input frame.
 *
 * If a block larger than ~10–15 chars lands in one input event (rather than
 * arriving keystroke-by-keystroke), that wasn't typed — flag it and classify
 * the origin:
 *
 *   - 'paste'   : a real clipboard paste (inputType insertFromPaste, or our
 *                 paste path already saw it).
 *   - 'ai'      : inserted by an AI flow (e.g. an accepted Gemini suggestion;
 *                 our synthetic insert is tagged so we don't double-count).
 *   - 'unknown' : a large single-frame insertion that is neither — the
 *                 interesting case (text injected/scripted, or "humanised"
 *                 content dropped in by means we don't otherwise observe).
 *
 * This is a heuristic SIGNAL, not proof: it says "this didn't come from typing,"
 * which combined with velocity + the Gemini detector strengthens provenance.
 */

// Minimum single-frame insertion size to treat as a block rather than typing.
// 12 sits above an autocomplete word and below a sentence.
export const BLOCK_MIN_CHARS = 12

/**
 * Classify an input event's text insertion.
 *
 * @param {object} info
 * @param {string} info.inputType      - the InputEvent.inputType
 * @param {number} info.insertedLength - number of chars inserted this frame
 * @param {boolean} [info.isAiInsert]  - true if this came from our AI insert
 *   path (carries the colophon-ai marker), so we attribute it to AI not paste.
 * @returns {{ isBlock: boolean, origin: 'paste'|'ai'|'unknown', chars: number }}
 */
export function classifyInsertion({ inputType = '', insertedLength = 0, isAiInsert = false } = {}) {
  const isBlock = insertedLength >= BLOCK_MIN_CHARS
  if (!isBlock) {
    return { isBlock: false, origin: 'typing', chars: insertedLength }
  }
  let origin
  if (isAiInsert) {
    origin = 'ai'
  } else if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop') {
    origin = 'paste'
  } else {
    origin = 'unknown'
  }
  return { isBlock: true, origin, chars: insertedLength }
}
