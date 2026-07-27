/**
 * storage.js — chrome.storage.local helpers
 *
 * Single source of truth for reading and writing extension state.
 * All session data lives here; nothing is persisted elsewhere.
 */

const DEFAULT_SETTINGS = {
  aiPath:          'ollama',
  ollamaEndpoint:  'http://localhost:11434',
  ollamaModel:     '',
  outputFormat:    'twff',
  geminiApiKey:    '',
}

export async function getSettings() {
  const data = await chrome.storage.local.get('settings')
  return { ...DEFAULT_SETTINGS, ...data.settings }
}

export async function saveSettings(partial) {
  const current = await getSettings()
  await chrome.storage.local.set({ settings: { ...current, ...partial } })
}

export async function getSession() {
  const data = await chrome.storage.local.get('session')
  return data.session ?? null
}

export async function saveSession(session) {
  await chrome.storage.local.set({ session })
}

export async function clearSession() {
  await chrome.storage.local.remove('session')
}

export async function getSessionByDocId(docId) {
  const data = await chrome.storage.local.get('sessions')
  return (data.sessions ?? {})[docId] ?? null
}

export async function saveSessionByDocId(docId, session) {
  const data = await chrome.storage.local.get('sessions')
  const sessions = data.sessions ?? {}
  sessions[docId] = session
  await chrome.storage.local.set({ sessions })
}

/**
 * Collapses consecutive runs (length >= 2) of plain `edit` events that fall
 * before the most recent `checkpoint` into a single `edit_summary` roll-up
 * each. `edit` events carry no text snapshot at all (only position/char-delta
 * bookkeeping — see flushEdit() in content/content.js), so this loses no
 * reconstructable information; every event with acceptance/provenance value
 * (ai_interaction, ai_suggestion, gemini_suggestion, paste, checkpoint,
 * heuristic_suggestion) is passed through untouched. Everything from the
 * most recent checkpoint onward is left alone (still "live").
 * Pure function — no chrome.* dependency — used by the service worker's
 * storage-quota auto-export/trim cycle.
 */
export function aggregateOldEditEvents(events) {
  let lastCheckpointIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'checkpoint') { lastCheckpointIdx = i; break }
  }
  if (lastCheckpointIdx <= 0) return { events, changed: false }

  const result = []
  let changed = false
  let run = []

  const flushRun = () => {
    if (run.length >= 2) {
      const charDeltaSum = run.reduce((s, e) => s + (e.meta?.char_delta ?? 0), 0)
      const charCountSum = run.reduce((s, e) => s + (e.meta?.char_count ?? 0), 0)
      result.push({
        timestamp: run[run.length - 1].timestamp,
        type: 'edit_summary',
        meta: {
          char_delta_sum: charDeltaSum,
          char_count_sum: charCountSum,
          source_event_count: run.length,
          first_ts: run[0].timestamp,
          last_ts: run[run.length - 1].timestamp,
          aggregated: true,
        },
      })
      changed = true
    } else {
      result.push(...run)
    }
    run = []
  }

  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (i < lastCheckpointIdx && (e.type === 'edit' || e.type === 'edit_block')) {
      run.push(e)
    } else {
      flushRun()
      result.push(e)
    }
  }
  flushRun()

  return { events: result, changed }
}

/**
 * Generate a fresh, anonymous, unlinkable author ID. Pure — no storage side effects.
 */
export async function generateUserId() {
  const raw = crypto.randomUUID()
  const bytes = new TextEncoder().encode(raw)
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return 'anon-' + hex.slice(0, 12)
}

/**
 * Returns `session.userId`, generating and attaching one if the session doesn't
 * have one yet. Mutates `session` in place — the caller is responsible for
 * persisting it (saveSession/saveSessionByDocId).
 *
 * This is the ID's whole rotation story: a session only ever gets a fresh ID
 * once, when it's first created, so the same ID stays stable for every event
 * within that session (they still correlate correctly) but a brand new
 * session always starts with a brand new ID — nothing links one session to
 * the next. This satisfies TWFF spec §6.2 ("SHOULD be rotatable between
 * sessions") using the session boundary itself, not an arbitrary timer, and
 * without persisting an identity that would outlive any single session.
 *
 * Cross-session/cross-document identity for longitudinal research is
 * deliberately NOT this ID's job — see SPEC.md §6.2 and READINESS.md for
 * where that lives instead (the authenticated web-app layer).
 */
export async function ensureSessionUserId(session) {
  if (session.userId) return session.userId
  session.userId = await generateUserId()
  return session.userId
}
