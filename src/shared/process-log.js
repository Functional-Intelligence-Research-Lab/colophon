/**
 * process-log.js — TWFF ProcessLog (JavaScript port)
 *
 * Ported from twff/glassbox/components/process_log.py.
 * Produces process-log.json conforming to TWFF v0.1 spec.
 * Hash chain follows SPEC §5.2 (SHA-256-CHAIN, per-event).
 */

export const SPEC_VERSION = '0.1.0'

/**
 * Recursively sort all object keys so JSON serialisation is deterministic.
 * Arrays are preserved in order. Primitives pass through unchanged.
 */
function deepSortKeys(value) {
  if (Array.isArray(value)) return value.map(deepSortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => {
      acc[k] = deepSortKeys(value[k])
      return acc
    }, {})
  }
  return value
}

function sortedJSON(value) {
  return JSON.stringify(deepSortKeys(value))
}

/**
 * Compute the per-event hash per SPEC §5.2.
 *
 * hash_input = sortedJSON({ meta, timestamp, type })
 *            + "|" + previousHash + "|" + sessionId
 */
async function computeEventHash(event, previousHash, sessionId) {
  const payload = sortedJSON({
    meta:      event.meta,
    timestamp: event.timestamp,
    type:      event.type,
  })
  const input = `${payload}|${previousHash}|${sessionId}`
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Build a spec-compliant process-log dict from a session object.
 *
 * @param {object} session  - session from chrome.storage.local
 * @param {string} userId   - anonymous user ID from settings
 * @returns {Promise<object>} - process-log.json structure
 */
export async function buildProcessLog(session, userId) {
  const endTime = new Date().toISOString()

  // Deep-copy events so we don't mutate storage
  const events = session.events.map(e => ({ ...e, meta: { ...e.meta } }))

  // Compute per-event hash chain (SPEC §5.2)
  let previousHash = ''
  for (const event of events) {
    event._hash = await computeEventHash(event, previousHash, session.sessionId)
    previousHash = event._hash
  }

  const headHash = events.length > 0 ? events[events.length - 1]._hash : ''

  return {
    version:        SPEC_VERSION,
    session_id:     session.sessionId,
    user_id:        userId,
    start_time:     session.startedAt,
    end_time:       endTime,
    content_source: 'content/document.xhtml',
    events,
    _integrity: {
      algorithm:    'SHA-256-CHAIN',
      chain_length: events.length,
      head_hash:    headHash,
      session_id:   session.sessionId,
      note:         'Per-event chained hash. Verify using spec §5.2.',
    },
  }
}
