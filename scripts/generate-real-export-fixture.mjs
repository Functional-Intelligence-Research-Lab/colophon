#!/usr/bin/env node
/**
 * generate-real-export-fixture.mjs
 *
 * Writes colophon-web/tests/fixtures/real_extension_export.json by calling
 * the extension's own production export function, buildProcessLog()
 * (colophon/src/shared/process-log.js) -- the same function
 * lib/process-log.js's live export path calls, and the same hash-chain
 * implementation (computeEventHash) the JS side actually ships.
 *
 * This exists because colophon-web/tests/test_twff_submit.py's make_log()
 * helper hand-builds events and computes hashes via twff_verify.py's
 * Python-side compute_event_hash() -- if the JS and Python hash algorithms
 * ever drifted, that test suite wouldn't catch it, since both sides of the
 * comparison come from the same (Python) implementation. This script
 * produces a fixture from the real JS implementation instead, so the
 * upload test that consumes it is checking something the Python side
 * didn't fabricate.
 *
 * Honest scope: this exercises the real hashing/export code path (Node's
 * actual crypto.subtle, no mocking), not a live browser DOM -- content.js's
 * DOM-dependent diffing (finding real text positions in a live Google Doc)
 * isn't part of what this proves. The session.events below are a realistic,
 * hand-constructed sequence in the exact shape content.js/service-worker.js
 * actually produce, run through the real export function rather than
 * through a second, hand-rolled hashing implementation.
 *
 * Run with: node scripts/generate-real-export-fixture.mjs
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildProcessLog } from '../src/shared/process-log.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SESSION_ID = 'd4a7f890-1111-4a2b-9c3d-abcdef123456'
const USER_ID = 'anon-fixture-user'

// A realistic sequence: session starts, a couple of ordinary human edits,
// a clipboard paste paired with its required edit_block(source:'external')
// at the same timestamp (the spec's own paste/edit_block pairing
// requirement), an AI-assisted suggestion the author accepted, then the
// session ends. event_id is present the same way content.js/service-
// worker.js add it (an internal-only identity) -- buildProcessLog() strips
// it before hashing/export, exactly as it does for a real session.
const events = [
  {
    event_id: 'evt-1',
    type: 'session_start',
    timestamp: '2026-09-02T14:00:00.000Z',
    meta: {},
  },
  {
    event_id: 'evt-2',
    type: 'edit_block',
    timestamp: '2026-09-02T14:01:12.500Z',
    meta: {
      source: 'human',
      position_start: 0,
      position_end: 42,
      position_reliability: 'exact',
      content_before: '',
      content_after: 'The history of writing technology begins',
      content_before_length: 0,
      content_after_length: 42,
      char_delta: 42,
      char_count: 42,
      insertion_velocity: 95,
      likely_ai: false,
      gemini_panel_context: false,
    },
  },
  {
    event_id: 'evt-3',
    type: 'paste',
    timestamp: '2026-09-02T14:03:40.000Z',
    meta: {
      source: 'external',
      char_count: 61,
      position_start: 42,
      position_end: 103,
      position_reliability: 'exact',
      content_preview: ' with clay tablets, long before paper existed at all.',
      content_before: '',
      content_after: '',
    },
  },
  {
    event_id: 'evt-4',
    type: 'edit_block',
    timestamp: '2026-09-02T14:03:40.000Z',
    meta: {
      source: 'external',
      position_start: 42,
      position_end: 103,
      position_reliability: 'exact',
      content_before: '',
      content_after: ' with clay tablets, long before paper existed at all.',
      content_before_length: 0,
      content_after_length: 61,
      char_count: 61,
    },
  },
  {
    event_id: 'evt-5',
    type: 'ai_interaction',
    timestamp: '2026-09-02T14:06:05.000Z',
    meta: {
      model: 'ollama/llama3.2',
      output_preview: 'Consider noting that clay tablets predate papyrus by centuries.',
      position_start: 103,
      position_end: 168,
      acceptance: 'fully_accepted',
      content_before: '[snapshot unavailable]',
      content_after: 'Consider noting that clay tablets predate papyrus by centuries.',
      ai_chars: 65,
      interaction_subtype: 'brainstorm',
    },
  },
  {
    event_id: 'evt-6',
    type: 'session_end',
    timestamp: '2026-09-02T14:10:00.000Z',
    meta: {},
  },
]

const session = {
  sessionId: SESSION_ID,
  startedAt: '2026-09-02T14:00:00.000Z',
  events,
}

const log = await buildProcessLog(session, USER_ID)

// A fixed end_time, not buildProcessLog()'s own new Date().toISOString(),
// so the committed fixture is reproducible byte-for-byte on every re-run
// rather than silently changing every time this script is executed.
log.end_time = '2026-09-02T14:10:00.000Z'

const outPath = path.join(__dirname, '..', '..', 'colophon-web', 'tests', 'fixtures', 'real_extension_export.json')
writeFileSync(outPath, JSON.stringify(log, null, 2) + '\n')
console.log(`Wrote ${outPath}`)
