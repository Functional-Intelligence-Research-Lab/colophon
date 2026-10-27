/**
 * content-edit-position.test.js
 *
 * Regression coverage for the core annotation-accuracy bug: ordinary human
 * typing (bufferEdit()/flushEdit()) used to send position_start:0 and a
 * keystroke-count delta as position_end, with no content_before/content_after
 * at all. The annotation engine can't locate an event with no real position or
 * content to search for, so a human edit made on top of previously-pasted
 * text could never override that text's provenance — reported as "pasted the
 * passage, retyped part of it, the whole thing still shows as 100% pasted."
 *
 * Covers: flushEdit() now diffs the document's state at buffer-start against
 * its state at flush time to recover the real position/content of the edit,
 * and falls back to the old delta-only shape when no usable diff is found.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetStore } from './setup.js'
import {
  bufferEdit, flushEdit, __setDocTextForTest, __setGeminiPanelActiveForTest,
} from '../src/content/content.js'

beforeEach(() => {
  resetStore()
  vi.useFakeTimers()
})

describe('flushEdit — real position/content for ordinary human edits', () => {
  it('captures the real inserted text and its document offset, not just a keystroke delta', () => {
    __setDocTextForTest('The quick fox jumps.')
    const sent = []
    global.chrome.runtime.sendMessage = (msg) => { sent.push(msg); return Promise.resolve({}) }

    bufferEdit(1, false, { fromKeydown: true }) // captures textBefore at buffer start
    __setDocTextForTest('The quick brown fox jumps.') // "brown " typed at position 10
    vi.advanceTimersByTime(1100)

    expect(sent).toHaveLength(1)
    const meta = sent[0].payload.meta
    expect(meta.position_start).toBe(10)
    expect(meta.position_end).toBe(16)
    expect(meta.content_before).toBe('')
    expect(meta.content_after).toBe('brown ')
    expect(meta.content_after_length).toBe(6)
    expect(meta.source).toBe('human')
  })

  it('captures a delete-and-retype in the middle of previously-pasted text', () => {
    // Mirrors the real reported scenario: a block of text already exists
    // (e.g. from a paste), and the user deletes part of it and types
    // something new in its place.
    __setDocTextForTest('AAAAABBBBBCCCCC')
    bufferEdit(1, false, { fromKeydown: true })
    const sent = []
    global.chrome.runtime.sendMessage = (msg) => { sent.push(msg); return Promise.resolve({}) }
    __setDocTextForTest('AAAAAxyCCCCC') // BBBBB (5 chars) replaced with xy (2 chars)
    vi.advanceTimersByTime(1100)

    expect(sent).toHaveLength(1)
    const meta = sent[0].payload.meta
    expect(meta.position_start).toBe(5)
    expect(meta.content_before).toBe('BBBBB')
    expect(meta.content_after).toBe('xy')
    expect(meta.content_before_length).toBe(5)
    expect(meta.content_after_length).toBe(2)
    expect(meta.char_delta).toBe(-3) // 2 added - 5 removed
  })

  it('falls back to the delta-only shape, with position keys omitted, when no document text is available', async () => {
    __setDocTextForTest('') // nothing to diff against
    const sent = []
    global.chrome.runtime.sendMessage = (msg) => { sent.push(msg); return Promise.resolve({}) }

    bufferEdit(4, false, { fromKeydown: true })
    // The debounce (1000ms) plus the one-shot retry (FLUSH_RETRY_MS) both
    // need to fire and their promises settle before the event ships.
    await vi.advanceTimersByTimeAsync(1200)

    expect(sent).toHaveLength(1)
    const meta = sent[0].payload.meta
    // position_start:0 (a false "really at document position 0") must not
    // survive when the diff never confirmed a real position — omitted, not
    // defaulted, so classifyReliability() on the consumer side can treat
    // this honestly as "position unknown" instead of guessing.
    expect('position_start' in meta).toBe(false)
    expect('position_end' in meta).toBe(false)
    expect(meta.content_after).toBeUndefined()
    expect(meta.char_delta).toBe(4)
  })

  it('falls back to the old shape, with position keys omitted, when the document text did not change at all', async () => {
    __setDocTextForTest('Same text throughout.')
    bufferEdit(1, false, { fromKeydown: true }) // e.g. a cursor move miscounted as a delta
    const sent = []
    global.chrome.runtime.sendMessage = (msg) => { sent.push(msg); return Promise.resolve({}) }
    // textAfter stays identical to textBefore
    await vi.advanceTimersByTimeAsync(1200)

    expect(sent).toHaveLength(1)
    const meta = sent[0].payload.meta
    expect('position_start' in meta).toBe(false)
    expect(meta.content_after).toBeUndefined()
  })
})

describe('flushEdit — a velocity/panel heuristic never promotes source or type to a confirmed AI claim', () => {
  // Neither insertion_velocity (a crude chars/sec estimate) nor
  // _geminiPanelActive (a MutationObserver watching for generic Google Docs
  // UI markers) is a confirmed AI interaction — no model identity, no
  // prompt, no real accept/reject. flushEdit() used to promote a "fast and
  // panel-active" edit to source:'ai' or an entirely separate
  // 'gemini_suggestion' type the viewer doesn't even recognize, making a
  // stacked guess look like a direct observation.

  it('keeps type:edit_block and source:human even for a fast, large insertion', () => {
    __setDocTextForTest('short')
    const sent = []
    global.chrome.runtime.sendMessage = (msg) => { sent.push(msg); return Promise.resolve({}) }

    // A single large buffered delta flushed after the full debounce yields
    // a high chars/sec estimate (delta / ~1s elapsed) -- exactly the
    // "suspiciously fast" case this fix must still not reclassify.
    bufferEdit(300, false, { fromKeydown: true })
    __setDocTextForTest('short' + 'x'.repeat(300))
    vi.advanceTimersByTime(1100)

    expect(sent).toHaveLength(1)
    const meta = sent[0].payload.meta
    expect(sent[0].payload.type).toBe('edit_block')
    expect(meta.source).toBe('human')
    expect(meta.likely_ai).toBe(true)
    expect(meta.insertion_velocity).toBeGreaterThan(150)
  })

  it('keeps type:edit_block and source:human even when the Gemini panel was contextually active, recording it as metadata instead', () => {
    __setDocTextForTest('short')
    __setGeminiPanelActiveForTest(true)
    const sent = []
    global.chrome.runtime.sendMessage = (msg) => { sent.push(msg); return Promise.resolve({}) }

    bufferEdit(300, false, { fromKeydown: true })
    __setDocTextForTest('short' + 'x'.repeat(300))
    vi.advanceTimersByTime(1100)

    expect(sent).toHaveLength(1)
    const meta = sent[0].payload.meta
    expect(sent[0].payload.type).toBe('edit_block')
    expect(meta.source).toBe('human')
    expect(meta.gemini_panel_context).toBe(true)
  })
})
