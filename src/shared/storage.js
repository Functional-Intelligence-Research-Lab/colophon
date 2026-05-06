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
  userId:          '',
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

/** Returns the persisted anonymous user ID, generating one if missing. */
export async function ensureUserId() {
  const settings = await getSettings()
  if (settings.userId) return settings.userId
  const userId = await _generateUserId()
  await saveSettings({ userId })
  return userId
}

async function _generateUserId() {
  const raw = crypto.randomUUID()
  const bytes = new TextEncoder().encode(raw)
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return 'anon-' + hex.slice(0, 12)
}
