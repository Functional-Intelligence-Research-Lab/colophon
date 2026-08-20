/**
 * status.js — runtime diagnostics
 *
 * Checks the live state of the extension:
 *   • Granted permissions (chrome.permissions API)
 *   • Service worker reachability
 *   • Content script attached to active Docs tab
 *   • Storage state (settings, session)
 *   • Manifest version & extension info
 *
 * Each check produces { id, label, status: 'ok'|'fail'|'warn', detail? }.
 * The overall banner is the worst status across all checks.
 */

const REQUIRED_PERMS = ['activeTab', 'storage', 'scripting', 'sidePanel']

const $ = id => document.getElementById(id)

// ── Entry ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', runAll)
$('btn-refresh').addEventListener('click', runAll)

async function runAll() {
  setOverall('checking', 'Running checks…')

  const groups = {
    'check-permissions': await checkPermissions(),
    'check-connections': await checkConnections(),
    'check-storage':     await checkStorage(),
    'check-recording':   await checkRecording(),
    'check-extension':   checkExtension(),
  }

  // Render
  for (const [id, items] of Object.entries(groups)) {
    renderList($(id), await items)
  }

  // Overall verdict
  const all = Object.values(groups).flatMap(g => g)
  setOverallVerdict(all)
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkPermissions() {
  const granted = await chrome.permissions.getAll()
  const checks = REQUIRED_PERMS.map(p => ({
    label: `Permission: ${p}`,
    status: granted.permissions?.includes(p) ? 'ok' : 'fail',
    detail: granted.permissions?.includes(p) ? 'granted' : 'NOT granted',
  }))
  // Detect any extra permissions not declared in the canonical list
  const extras = (granted.permissions ?? []).filter(p => !REQUIRED_PERMS.includes(p))
  if (extras.length > 0) {
    checks.push({
      label: 'No unexpected permissions',
      status: 'warn',
      detail: `extra: ${extras.join(', ')}`,
    })
  } else {
    checks.push({ label: 'No unexpected permissions', status: 'ok' })
  }
  // Host permission for Docs
  const hostOk = granted.origins?.some(o => o.includes('docs.google.com'))
  checks.push({
    label: 'Host: docs.google.com',
    status: hostOk ? 'ok' : 'fail',
    detail: hostOk ? 'granted' : 'missing',
  })
  return checks
}

async function checkConnections() {
  const out = []

  // Service worker reachability — ping it via GET_STATE
  let swOk = false
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
    swOk = res !== undefined
    out.push({
      label: 'Service worker responsive',
      status: swOk ? 'ok' : 'fail',
      detail: swOk ? 'GET_STATE returned a response' : 'no response',
    })
  } catch (err) {
    out.push({
      label: 'Service worker responsive',
      status: 'fail',
      detail: err.message,
    })
  }

  // Content script attached to current active tab — only meaningful on Docs
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.url?.startsWith('https://docs.google.com/document/')) {
    let injected = false
    try {
      // Send a no-op ping; content script ignores unknown messages but the
      // promise resolves without rejection if a listener is registered.
      await chrome.tabs.sendMessage(tab.id, { type: '__PING__' })
      injected = true
    } catch {
      injected = false
    }
    out.push({
      label: 'Content script in active Docs tab',
      status: injected ? 'ok' : 'warn',
      detail: injected ? 'attached' : 'not attached — reload the doc',
    })
  } else {
    out.push({
      label: 'Active tab is a Google Docs document',
      status: 'warn',
      detail: 'open a Docs document to test content script injection',
    })
  }

  return out
}

async function checkStorage() {
  const out = []
  try {
    const data = await chrome.storage.local.get(['settings', 'session'])
    out.push({
      label: 'chrome.storage.local readable',
      status: 'ok',
      detail: `${Object.keys(data).length} key(s) present`,
    })
    out.push({
      label: 'Settings configured',
      status: data.settings ? 'ok' : 'warn',
      detail: data.settings
        ? `aiPath=${data.settings.aiPath ?? 'default'}`
        : 'using defaults',
    })
    out.push({
      label: 'User ID present',
      status: data.settings?.userId ? 'ok' : 'warn',
      detail: data.settings?.userId ?? 'not yet generated',
    })
  } catch (err) {
    out.push({
      label: 'chrome.storage.local readable',
      status: 'fail',
      detail: err.message,
    })
  }
  return out
}

async function checkRecording() {
  const out = []
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
    if (!state?.session) {
      out.push({
        label: 'Active session',
        status: 'warn',
        detail: 'no session — click Start in the popup',
      })
      return out
    }
    out.push({
      label: 'Active session',
      status: 'ok',
      detail: state.session.sessionId.slice(0, 8) + '…',
    })
    out.push({
      label: 'Recording flag',
      status: state.session.isRecording ? 'ok' : 'warn',
      detail: state.session.isRecording ? 'recording' : 'stopped',
    })
    out.push({
      label: 'Events captured',
      status: state.session.events.length > 0 ? 'ok' : 'warn',
      detail: `${state.session.events.length} event(s)`,
    })
  } catch (err) {
    out.push({
      label: 'Recording state readable',
      status: 'fail',
      detail: err.message,
    })
  }
  return out
}

function checkExtension() {
  const m = chrome.runtime.getManifest()
  return [
    { label: 'Extension name',     status: 'ok', detail: m.name },
    { label: 'Extension version',  status: 'ok', detail: `v${m.version}` },
    { label: 'Manifest version 3', status: m.manifest_version === 3 ? 'ok' : 'fail', detail: `v${m.manifest_version}` },
    { label: 'Extension ID',       status: 'ok', detail: chrome.runtime.id },
  ]
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderList(ul, items) {
  ul.innerHTML = ''
  for (const item of items) {
    const li = document.createElement('li')
    li.className = item.status

    const icon = document.createElement('span')
    icon.className = 'icon'
    icon.textContent = item.status === 'ok' ? '✓' : item.status === 'fail' ? '✗' : '⚠'

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = item.label

    li.append(icon, label)

    if (item.detail) {
      const detail = document.createElement('span')
      detail.className = 'detail'
      detail.textContent = '— ' + item.detail
      li.append(detail)
    }
    ul.appendChild(li)
  }
}

function setOverall(kind, msg) {
  const el = $('overall')
  el.className = `overall overall--${kind}`
  el.textContent = msg
}

function setOverallVerdict(items) {
  const hasFail = items.some(i => i.status === 'fail')
  const hasWarn = items.some(i => i.status === 'warn')
  if (hasFail)      setOverall('fail', '✗ Some checks failed — see details below')
  else if (hasWarn) setOverall('warn', '⚠ Mostly fine — a few items need attention')
  else              setOverall('ok',   '✓ Everything looks good — you are good to go')
}
