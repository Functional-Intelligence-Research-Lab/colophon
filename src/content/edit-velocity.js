/**
 * edit-velocity.js — Typing-speed (edit velocity) helper.
 *
 * Computes chars-per-minute for a burst of real keystrokes and flags bursts too
 * fast to be human-typed — a signal for AI text pasted then disguised as typing.
 *
 * Noise handling:
 *   - PAUSES: gaps longer than PAUSE_GAP_MS between keystrokes are NOT counted
 *     as typing time. Otherwise a 2-minute think-pause would make real typing
 *     look artificially slow. We sum only "active" inter-keystroke time.
 *   - DELETE/BACKSPACE (churn): counted separately, not as forward progress.
 *     They neither inflate the rate nor get mistaken for produced characters.
 *
 * IMPORTANT (paste safety): this only ever sees keystrokes that content.js's
 * bufferEdit() has already let through its PASTE_SUPPRESSION_MS guard, so
 * pasted text never reaches the velocity counter. Velocity and paste logging
 * stay fully independent.
 *
 * Extracted into its own module (rather than living inside the content script)
 * so the math is unit-testable.
 */

// Above this chars-per-minute a burst is implausibly fast for human typing
// (~250 wpm ≈ 1250 cpm is near the world record), so we flag it for review.
export const HUMAN_CPM_CEILING = 1500

// Inter-keystroke gaps longer than this are treated as a pause, not typing
// time, so idle/thinking time doesn't drag the measured rate down.
export const PAUSE_GAP_MS = 2000

/**
 * Create a fresh velocity accumulator. content.js feeds it one keystroke at a
 * time via record(); read the result with summary().
 */
export function createVelocityTracker() {
  let producedKeys = 0   // forward characters typed
  let churnKeys = 0      // backspace/delete
  let activeMs = 0       // summed inter-keystroke time, excluding pauses
  let lastAt = null

  function record(isDelete, at) {
    if (isDelete) {
      churnKeys += 1
    } else {
      producedKeys += 1
    }
    if (lastAt !== null) {
      const gap = at - lastAt
      // Only count the gap toward active typing time if it's a plausible
      // intra-typing interval (not a pause).
      if (gap > 0 && gap <= PAUSE_GAP_MS) activeMs += gap
    }
    lastAt = at
  }

  function summary() {
    return {
      chars_per_min: velocityFrom(producedKeys, activeMs),
      produced_keys: producedKeys,
      churn_keys: churnKeys,
      active_ms: activeMs,
    }
  }

  return { record, summary }
}

/**
 * Chars-per-minute from a produced-key count over active typing time.
 * Returns null when there isn't enough signal to be meaningful (fewer than two
 * produced keys, or no measured active span) — callers treat null as
 * "not measured" and omit the velocity fields rather than report a bogus rate.
 */
export function velocityFrom(producedKeys, activeMs) {
  if (producedKeys < 2 || activeMs <= 0) return null
  return Math.round((producedKeys / activeMs) * 60000)
}

/** True when a measured velocity exceeds plausible human typing speed. */
export function isTooFastForHuman(cpm) {
  return cpm !== null && cpm > HUMAN_CPM_CEILING
}
