#!/usr/bin/env node
/**
 * tools/status.js — Colophon Sprint 1 status checklist
 *
 * Usage:  node tools/status.js
 *         npm run status
 *
 * Checks every acceptance criterion for Sprint 1 issues #2, #20, #21, #22, #23.
 * Exit 0 = all required checks pass. Exit 1 = one or more failures.
 */

import { readFileSync, existsSync } from 'node:fs'
import { execSync }                  from 'node:child_process'

// ── Terminal colours ──────────────────────────────────────────────────────────

const G = s => `\x1b[32m${s}\x1b[0m`
const R = s => `\x1b[31m${s}\x1b[0m`
const Y = s => `\x1b[33m${s}\x1b[0m`
const B = s => `\x1b[1m${s}\x1b[0m`

const ok   = msg => `  ${G('✓')} ${msg}`
const fail = msg => `  ${R('✗')} ${msg}`
const warn = msg => `  ${Y('⚠')} ${msg}`
const head = msg => `\n${B(msg)}`

let _passed = 0
let _failed = 0

function check(label, condition, { required = true } = {}) {
  if (condition) {
    console.log(ok(label))
    _passed++
  } else if (required) {
    console.log(fail(label))
    _failed++
  } else {
    console.log(warn(`${label} (not required yet)`))
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileExists(path)    { return existsSync(path) }
function readJSON(path)      { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

function run(cmd) {
  try { execSync(cmd, { stdio: 'pipe' }); return true } catch { return false }
}

// ── Checks ────────────────────────────────────────────────────────────────────

console.log(B('\nColophon — Sprint 1 Status Checklist'))
console.log('━'.repeat(50))

// ── Environment
console.log(head('Environment'))
const nodeVer = process.versions.node.split('.').map(Number)
check('Node.js >= 18',          nodeVer[0] >= 18)
check('node_modules present',   fileExists('node_modules'))
check('package.json present',   fileExists('package.json'))

// ── Issue #2 — Manifest V3 scaffold
console.log(head('Issue #2 — Manifest V3 scaffold'))

const manifest = readJSON('dist/manifest.json')
check('dist/manifest.json exists and is valid JSON',    manifest !== null)
check('manifest_version is 3',                          manifest?.manifest_version === 3)
check('permission: activeTab',                          manifest?.permissions?.includes('activeTab'))
check('permission: storage',                            manifest?.permissions?.includes('storage'))
check('permission: scripting',                          manifest?.permissions?.includes('scripting'))
check('permission: sidePanel',                          manifest?.permissions?.includes('sidePanel'))

// Strict per issue #2: ONLY those four permissions, nothing extra
const allowed = ['activeTab', 'storage', 'scripting', 'sidePanel']
const extra   = (manifest?.permissions ?? []).filter(p => !allowed.includes(p))
check(`No extra permissions (got: ${(manifest?.permissions ?? []).join(', ') || 'none'})`, extra.length === 0)

check('host_permission: docs.google.com',               manifest?.host_permissions?.some(h => h.includes('docs.google.com')))
check('background service_worker declared',             !!manifest?.background?.service_worker)
check('content_scripts declared',                       manifest?.content_scripts?.length > 0)
check('action.default_popup declared',                  !!manifest?.action?.default_popup)

// ── Issue #2 — dist/ files
console.log(head('Issue #2 — Build output'))
const distFiles = [
  'dist/manifest.json',
  'dist/background/service-worker.js',
  'dist/content/content.js',
  'dist/popup/popup.html',
  'dist/popup/popup.js',
  'dist/popup/popup.css',
  'dist/options/options.html',
  'dist/options/options.js',
  'dist/options/options.css',
]
for (const f of distFiles) check(f, fileExists(f))

// ── Issue #20 — Session lifecycle (source checks)
console.log(head('Issue #20 — Session lifecycle'))
const sw = existsSync('src/background/service-worker.js')
  ? readFileSync('src/background/service-worker.js', 'utf8') : ''
check('service-worker.js exists',               sw.length > 0)
check('crypto.randomUUID() used for session ID', sw.includes('crypto.randomUUID()'))
check('ISO 8601 timestamp on session start',    sw.includes('toISOString()'))
check('clearSession on new session start',      sw.includes('clearSession()'))

// ── Issue #21 — Edit event capture (source checks)
console.log(head('Issue #21 — Edit event capture'))
const cs = existsSync('src/content/content.js')
  ? readFileSync('src/content/content.js', 'utf8') : ''
check('content.js exists',                           cs.length > 0)
check('keydown listener (canvas renderer support)',  cs.includes('keydown'))
check('MutationObserver (legacy renderer support)',  cs.includes('MutationObserver'))
check('edit events debounced (not per-keystroke)',   cs.includes('DEBOUNCE_MS'))
check('paste events captured',                       cs.includes("type: 'paste'"))
check('focus_change events captured',               cs.includes("type: 'focus_change'"))
check('Dormant by default (ACTIVATE message)',        cs.includes("'ACTIVATE'"))

// ── Issue #22 — Popup UI (source checks)
console.log(head('Issue #22 — Popup UI'))
const popup = existsSync('src/popup/popup.html')
  ? readFileSync('src/popup/popup.html', 'utf8') : ''
check('popup.html exists',                     popup.length > 0)
check('status indicator present',              popup.includes('status-dot'))
check('recording status label present',        popup.includes('status-label'))
check('edit count stat present',               popup.includes('stat-edits'))
check('AI count stat present',                 popup.includes('stat-ai'))
check('duration stat present',                 popup.includes('stat-duration'))
check('Start/Stop toggle button present',      popup.includes('btn-toggle'))
check('Export button present',                 popup.includes('btn-export'))
check('Settings link present',                 popup.includes('link-settings'))

// ── Issue #23 — Export (source checks)
console.log(head('Issue #23 — Local export'))
const pl = existsSync('src/shared/process-log.js')
  ? readFileSync('src/shared/process-log.js', 'utf8') : ''
check('process-log.js exists',                      pl.length > 0)
check('SPEC_VERSION "0.1.0" declared',              pl.includes('0.1.0'))
check('SHA-256-CHAIN algorithm',                    pl.includes('SHA-256-CHAIN'))
check('Per-event hash chain (computeEventHash)',    pl.includes('computeEventHash'))
check('_integrity block written',                   pl.includes('_integrity'))
check('buildProcessLog exported',                   pl.includes('export async function buildProcessLog'))
check('.twff ZIP export (JSZip — issue #23)',
  existsSync('node_modules/jszip'), { required: false })

// ── Tests
console.log(head('Automated tests'))
check('npm test passes', run('npm test --silent'))

// ── Settings page
console.log(head('Settings page'))
check('options.html has AI path selector',     existsSync('src/options/options.html') &&
  readFileSync('src/options/options.html','utf8').includes('aiPath'))
check('options.html has Ollama settings',      existsSync('src/options/options.html') &&
  readFileSync('src/options/options.html','utf8').includes('ollama-endpoint'))
check('options.html has output format choice', existsSync('src/options/options.html') &&
  readFileSync('src/options/options.html','utf8').includes('outputFormat'))
check('options.html has privacy section',      existsSync('src/options/options.html') &&
  readFileSync('src/options/options.html','utf8').includes('privacy-list'))
check('options.html has user ID + rotate',     existsSync('src/options/options.html') &&
  readFileSync('src/options/options.html','utf8').includes('btn-rotate'))

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '━'.repeat(50))
const total = _passed + _failed
if (_failed === 0) {
  console.log(G(`✓ All ${total} checks passed.\n`))
  process.exit(0)
} else {
  console.log(R(`✗ ${_failed} of ${total} checks failed.\n`))
  process.exit(1)
}
