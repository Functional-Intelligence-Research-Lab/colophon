import { getSettings, saveSettings, ensureUserId } from '../shared/storage.js'

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const settings = await getSettings()
  const userId   = await ensureUserId()

  // Populate all fields from stored settings
  setRadio('aiPath', settings.aiPath)
  setRadio('outputFormat', settings.outputFormat)
  document.getElementById('ollama-endpoint').value = settings.ollamaEndpoint
  document.getElementById('ollama-model').value    = settings.ollamaModel
  document.getElementById('gemini-key').value      = settings.geminiApiKey
  document.getElementById('user-id').textContent   = userId

  updateConditionalSections(settings.aiPath)

  // Wire up all inputs to auto-save on change
  document.querySelectorAll('input[name="aiPath"]').forEach(el =>
    el.addEventListener('change', () => {
      updateConditionalSections(el.value)
      save({ aiPath: el.value })
    })
  )

  document.querySelectorAll('input[name="outputFormat"]').forEach(el =>
    el.addEventListener('change', () => save({ outputFormat: el.value }))
  )

  document.getElementById('ollama-endpoint').addEventListener('change', e =>
    save({ ollamaEndpoint: e.target.value.trim() || 'http://localhost:11434' })
  )

  document.getElementById('ollama-model').addEventListener('change', e =>
    save({ ollamaModel: e.target.value.trim() })
  )

  document.getElementById('gemini-key').addEventListener('change', e =>
    save({ geminiApiKey: e.target.value.trim() })
  )

  document.getElementById('btn-rotate').addEventListener('click', rotateUserId)
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function save(partial) {
  await saveSettings(partial)
  flashSaved()
}

function flashSaved() {
  const el = document.getElementById('save-indicator')
  el.hidden = false
  clearTimeout(el._timer)
  el._timer = setTimeout(() => { el.hidden = true }, 1500)
}

// ── User ID rotation ──────────────────────────────────────────────────────────

async function rotateUserId() {
  const raw = crypto.randomUUID()
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  const newId = 'anon-' + hex.slice(0, 12)
  await save({ userId: newId })
  document.getElementById('user-id').textContent = newId
}

// ── Conditional visibility ────────────────────────────────────────────────────

function updateConditionalSections(aiPath) {
  document.getElementById('section-ollama').hidden      = aiPath !== 'ollama'
  document.getElementById('section-gemini-api').hidden  = aiPath !== 'gemini-api'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`)
  if (el) el.checked = true
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init()
