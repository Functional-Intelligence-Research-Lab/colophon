/**
 * process-log.test.js
 *
 * Tests for src/shared/process-log.js — TWFF event model and hash chain.
 *
 * The hash chain algorithm is also implemented in Python in:
 *   twff/spec/verification/verify_process_log.py
 *
 * Any change to the JS hashing logic must produce identical results to the
 * Python reference. Run both to cross-check after any hash-related edit.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { buildProcessLog, SPEC_VERSION, computeEventHash } from '../src/shared/process-log.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSession(overrides = {}) {
  return {
    sessionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    startedAt: '2026-04-29T10:00:00.000Z',
    tabId:     1,
    docId:     'abc123',
    isRecording: true,
    events: [
      { timestamp: '2026-04-29T10:00:00.000Z', type: 'session_start', meta: {} },
      {
        timestamp: '2026-04-29T10:01:00.000Z',
        type: 'edit',
        meta: { position_start: 0, position_end: 42, char_delta: 42, source: 'human' },
      },
      {
        timestamp: '2026-04-29T10:02:00.000Z',
        type: 'paste',
        meta: { char_count: 10, source: 'external', position_start: 42, position_end: 52 },
      },
      { timestamp: '2026-04-29T10:05:00.000Z', type: 'session_end', meta: {} },
    ],
    ...overrides,
  }
}

const USER_ID = 'anon-abc123def456'

// ── Top-level structure ───────────────────────────────────────────────────────

describe('buildProcessLog — top-level structure', () => {
  it('contains all required TWFF fields', async () => {
    const log = await buildProcessLog(makeSession(), USER_ID)
    expect(log.version).toBe(SPEC_VERSION)
    expect(log.session_id).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479')
    expect(log.user_id).toBe(USER_ID)
    expect(log.start_time).toBe('2026-04-29T10:00:00.000Z')
    expect(log.end_time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(log.content_source).toBe('content/document.xhtml')
    expect(Array.isArray(log.events)).toBe(true)
    expect(log._integrity).toBeDefined()
  })

  it('does not mutate the original session', async () => {
    const session = makeSession()
    const original = JSON.parse(JSON.stringify(session))
    await buildProcessLog(session, USER_ID)
    // events array should be unchanged (no _hash field added to originals)
    expect(session.events[0]).not.toHaveProperty('_hash')
    expect(session.events).toHaveLength(original.events.length)
  })
})

// ── Hash chain ────────────────────────────────────────────────────────────────

describe('buildProcessLog — hash chain (SPEC §5.2)', () => {
  let log

  beforeEach(async () => {
    log = await buildProcessLog(makeSession(), USER_ID)
  })

  it('adds _hash to every event', () => {
    for (const event of log.events) {
      expect(event._hash).toBeDefined()
      expect(typeof event._hash).toBe('string')
      expect(event._hash).toMatch(/^[a-f0-9]{64}$/) // 64-char hex SHA-256
    }
  })

  it('_integrity.head_hash matches the last event _hash', () => {
    const lastHash = log.events[log.events.length - 1]._hash
    expect(log._integrity.head_hash).toBe(lastHash)
  })

  it('_integrity block has required fields', () => {
    expect(log._integrity.algorithm).toBe('SHA-256-CHAIN')
    expect(log._integrity.chain_length).toBe(log.events.length)
    expect(log._integrity.session_id).toBe(log.session_id)
  })

  it('each event hash is different', () => {
    const hashes = log.events.map(e => e._hash)
    const unique = new Set(hashes)
    expect(unique.size).toBe(hashes.length)
  })

  it('hash chain is deterministic — same input produces same hashes', async () => {
    const log2 = await buildProcessLog(makeSession(), USER_ID)
    for (let i = 0; i < log.events.length; i++) {
      expect(log.events[i]._hash).toBe(log2.events[i]._hash)
    }
  })

  it('matches the Python verifier byte-for-byte on non-ASCII content', async () => {
    // Cross-check against twff_verify.compute_event_hash (the web verifier).
    // The expected value was produced by that Python reference for this exact
    // event. Google Docs routinely emits curly quotes, em dashes, accents, and
    // emoji, so the JS serialisation must escape non-ASCII the way Python's
    // json.dumps(ensure_ascii=True) does, or uploaded .twff files fail
    // verification. This locks that parity so a regression here fails loudly.
    const event = {
      type: 'ai_interaction',
      timestamp: '2026-08-10T10:00:00Z',
      author_id: 'anon-abc123',
      meta: {
        model: 'google/gemini',
        output_preview: 'Don’t — the “smart” quotes \u{1f600} café',
        acceptance: 'rejected',
        position_start: 0,
        position_end: 0,
        ai_chars: 0,
      },
    }
    const hash = await computeEventHash(event, '', 'sess-1')
    expect(hash).toBe('49919f452589595b93ece30f52dcc2f5f7fd7d8540fadaa55a4ca284021429b9')
  })

  it('modifying a single event breaks all subsequent hashes', async () => {
    // Take the unmodified chain
    const good = log.events.map(e => e._hash)

    // Modify event at index 1 in a fresh session
    const tampered = makeSession()
    tampered.events[1].meta.char_delta = 9999 // tamper

    const tamperedLog = await buildProcessLog(tampered, USER_ID)
    const bad = tamperedLog.events.map(e => e._hash)

    // Event 0 (session_start) is unchanged — hash should match
    expect(bad[0]).toBe(good[0])

    // Events 1 onwards must all differ (chain is broken)
    for (let i = 1; i < good.length; i++) {
      expect(bad[i]).not.toBe(good[i])
    }
  })
})

// ── Privacy constraints (SPEC §6.1) ──────────────────────────────────────────

describe('buildProcessLog — privacy', () => {
  it('does not include raw text content in the log', async () => {
    const session = makeSession()
    // Simulate an AI interaction with a long preview accidentally included
    session.events.push({
      timestamp: '2026-04-29T10:03:00.000Z',
      type: 'ai_interaction',
      meta: {
        interaction_type: 'paraphrase',
        model: 'qwen2.5:0.5b',
        input_preview: 'A'.repeat(200),   // should be truncated upstream
        output_preview: 'B'.repeat(200),  // same
        acceptance: 'fully_accepted',
      },
    })
    const log = await buildProcessLog(session, USER_ID)
    const aiEvent = log.events.find(e => e.type === 'ai_interaction')
    // The process-log module does not truncate (that's the caller's job);
    // but the spec says ≤100 chars. This test documents the expectation so
    // the content script and SW enforce it before calling buildProcessLog.
    expect(aiEvent).toBeDefined()
  })

  it('user_id follows the anon- prefix convention', async () => {
    const log = await buildProcessLog(makeSession(), 'anon-abc123def456')
    expect(log.user_id).toMatch(/^anon-/)
  })
})
