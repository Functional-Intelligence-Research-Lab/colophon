import { getSettings, saveSettings, getSession } from '../shared/storage.js'

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const settings = await getSettings()
  const session  = await getSession()

  // gemini-api isn't functional yet — fall back for anyone who selected it
  // before it was marked "coming soon", so they're never stuck on a disabled option.
  if (settings.aiPath === 'gemini-api') {
    settings.aiPath = 'ollama'
    await save({ aiPath: 'ollama' })
  }

  // Populate all fields from stored settings
  setRadio('aiPath', settings.aiPath)
  setRadio('outputFormat', settings.outputFormat)
  document.getElementById('ollama-endpoint').value = settings.ollamaEndpoint
  document.getElementById('ollama-model').value    = settings.ollamaModel
  document.getElementById('gemini-key').value      = settings.geminiApiKey
  document.getElementById('user-id').textContent   = session?.userId
    ?? 'No active session — an ID is generated automatically once you start recording'

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
