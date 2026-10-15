/**
 * process-log-export.test.js — src/lib/process-log.js's ProcessLog.toDict()
 *
 * This is the live export path: service-worker.js's exportSession() assigns the
 * real session events (built via lib/events.js's constructors) onto
 * `logger.events`, then calls logger.export() -> toDict(). It is a different
 * module from src/shared/process-log.js (tested in process-log.test.js), which
 * implements the spec-compliant hash chain but isn't wired into this live path.
 *
 * Per TWFF spec v0.2 §6.1, no field should be unbounded. lib/events.js already
 * clips content_before/content_after to 500 chars at event-creation time, but
 * aiSuggestionEvent's `text` field is deliberately left full there for the side
 * panel's live rendering — toDict() is where that must get capped before an
 * event can leave the machine in an exported .twff file.
 */

import { describe, it, expect } from 'vitest'
import { ProcessLog } from '../src/lib/process-log.js'
import { computeEventHash } from '../src/shared/process-log.js'

describe('ProcessLog.toDict() — export sanitization', () => {
  it('clips an unbounded meta.text field to 500 chars', () => {
    const log = new ProcessLog('anon-test')
    log.events.push({
      timestamp: '2026-04-29T10:01:00.000Z',
      type: 'ai_suggestion',
      meta: {
        model: 'ollama/llama3',
        output_preview: 'A'.repeat(100),
        text: 'B'.repeat(2000), // unbounded at capture time — for side-panel rendering
        acceptance: 'pending',
      },
    })

    const dict = log.toDict()
    const suggestion = dict.events.find(e => e.type === 'ai_suggestion')
    expect(suggestion.meta.text.length).toBe(500)
    expect(suggestion.meta.text).toBe('B'.repeat(500))
  })

  it('clips an unbounded meta.reason field to 500 chars', () => {
    const log = new ProcessLog('anon-test')
    log.events.push({
      timestamp: '2026-04-29T10:01:00.000Z',
      type: 'ai_interaction',
      meta: {
        model: 'ollama/llama3',
        output_preview: 'preview',
        acceptance: 'rejected',
        reason: 'C'.repeat(900),
      },
    })

    const dict = log.toDict()
    const interaction = dict.events.find(e => e.type === 'ai_interaction')
    expect(interaction.meta.reason.length).toBe(500)
  })

  it('leaves events without text/reason fields untouched', () => {
    const log = new ProcessLog('anon-test')
    log.events.push({
      timestamp: '2026-04-29T10:01:00.000Z',
      type: 'edit_block',
      meta: { source: 'human', position_start: 0, position_end: 10 },
    })

    const dict = log.toDict()
    const edit = dict.events.find(e => e.type === 'edit_block')
    expect(edit.meta).toEqual({ source: 'human', position_start: 0, position_end: 10 })
  })

  it('does not mutate the original in-memory events (side panel still sees full text)', () => {
    const log = new ProcessLog('anon-test')
    const longText = 'D'.repeat(2000)
    log.events.push({
      timestamp: '2026-04-29T10:01:00.000Z',
      type: 'ai_suggestion',
      meta: { model: 'x', output_preview: 'p', text: longText, acceptance: 'pending' },
    })

    log.toDict()

    // The live in-memory event (what the side panel renders from) must still
    // have the full text — only the exported dict is sanitized.
    const liveEvent = log.events.find(e => e.type === 'ai_suggestion')
    expect(liveEvent.meta.text).toBe(longText)
  })

  it('includes all required top-level TWFF fields', () => {
    const log = new ProcessLog('anon-test')
    const dict = log.toDict()
    expect(dict.version).toBe(ProcessLog.SPEC_VERSION)
    expect(dict.session_id).toBe(log.sessionId)
    expect(dict.user_id).toBe('anon-test')
    expect(dict.content_source).toBe('content/document.xhtml')
    expect(Array.isArray(dict.events)).toBe(true)
  })
})

describe('ProcessLog._applyIntegrityChain() — spec §5.2 hash chain', () => {
  it('produces an _integrity block matching the schema/verifier field names', async () => {
    const log = new ProcessLog('anon-test')
    log.events.push({ timestamp: '2026-04-29T10:01:00.000Z', type: 'edit_block', meta: {} })
    const dict = log.toDict()
    await log._applyIntegrityChain(dict)

    expect(dict._integrity.algorithm).toBe('SHA-256-CHAIN')
    expect(dict._integrity.chain_length).toBe(dict.events.length)
    expect(dict._integrity.head_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(dict._integrity.session_id).toBe(log.sessionId)
  })

  it('stamps every event with a _hash', async () => {
    const log = new ProcessLog('anon-test')
    log.events.push({ timestamp: '2026-04-29T10:01:00.000Z', type: 'edit_block', meta: {} })
    const dict = log.toDict()
    await log._applyIntegrityChain(dict)

    for (const event of dict.events) {
      expect(event._hash).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('head_hash is the last event\'s _hash — chain order matters', async () => {
    const log = new ProcessLog('anon-test')
    log.events.push({ timestamp: '2026-04-29T10:01:00.000Z', type: 'edit_block', meta: {} })
    const dict = log.toDict()
    await log._applyIntegrityChain(dict)

    expect(dict._integrity.head_hash).toBe(dict.events[dict.events.length - 1]._hash)
  })

  it('hashes the sanitized (clipped) event content, not the original — the exported file always matches its own hash', async () => {
    const log = new ProcessLog('anon-test')
    const longText = 'E'.repeat(2000)
    log.events.push({
      timestamp: '2026-04-29T10:01:00.000Z',
      type: 'ai_suggestion',
      meta: { model: 'x', output_preview: 'p', text: longText, acceptance: 'pending' },
    })
    const dict = log.toDict()
    await log._applyIntegrityChain(dict)

    // The hashed event's own meta.text must be the clipped 500-char value —
    // if the chain had run over the unsanitized in-memory events instead,
    // this hash would not verify against the file's actual written content.
    const suggestion = dict.events.find(e => e.type === 'ai_suggestion')
    expect(suggestion.meta.text).toHaveLength(500)

    // Recompute independently: if the chain had hashed the original
    // 2000-char text instead of the clipped 500-char value actually written
    // to the file, this recomputed hash would not match.
    const idx = dict.events.indexOf(suggestion)
    const previousHash = idx === 0 ? '' : dict.events[idx - 1]._hash
    const { _hash, ...eventWithoutHash } = suggestion
    const recomputed = await computeEventHash(eventWithoutHash, previousHash, log.sessionId)
    expect(recomputed).toBe(_hash)
  })
})

describe('ProcessLog.buildMetadata() — document title', () => {
  it('carries a real captured title through to the exported metadata', async () => {
    const log = new ProcessLog('anon-test')
    log.title = 'My Real Essay Title'
    const meta = await log.buildMetadata()
    expect(meta.title).toBe('My Real Essay Title')
  })

  it('is null, not a fabricated placeholder, when no title was ever captured', async () => {
    const log = new ProcessLog('anon-test')
    // log.title deliberately never set — exportSession() assigns it from
    // session.title, which is null for a session that started before this
    // fix, or if the doc genuinely never had a readable title.
    const meta = await log.buildMetadata()
    expect(meta.title).toBeNull()
  })
})
