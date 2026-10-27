/**
 * content-paste-pairing.test.js
 *
 * TWFF spec (edit_block, "Relationship with paste"): a clipboard paste MUST
 * emit both a `paste` event (clipboard metadata) AND an `edit_block` with
 * source:'external' (the content change itself) at the same timestamp — the
 * edit_block is not a substitute for paste. emitPaste() used to only ever
 * send the `paste` event; the viewer's classifyLayer() was already built to
 * expect the pairing (an edit_block/external layer defers its classification
 * to the paired paste layer, and supplies the real content_before_length/
 * content_after_length the position-drift math needs), so this was a
 * producer gap against an already-tested consumer contract, not a missing
 * design. Covers the fix.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetStore } from './setup.js'
import { emitPaste, __setDocTextForTest } from '../src/content/content.js'

function fakeTextResponse(text) {
  return Promise.resolve({ ok: true, text: () => Promise.resolve(text) })
}

beforeEach(() => {
  resetStore()
  vi.useFakeTimers()
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
})

describe('emitPaste — paired edit_block(source:external) emission', () => {
  it('sends both a paste event and a same-timestamp edit_block(external) when the paste is located', async () => {
    __setDocTextForTest('Before the paste.')
    global.fetch = () => fakeTextResponse('Before PASTED TEXT the paste.')
    const sent = []
    global.chrome.runtime.sendMessage = (msg) => {
      if (msg.action === 'GET_PENDING_AI_OUTPUT') return Promise.resolve({})
      sent.push(msg)
      return Promise.resolve({})
    }

    const promise = emitPaste('PASTED TEXT')
    await vi.advanceTimersByTimeAsync(1100)
    await promise

    expect(sent).toHaveLength(2)

    const [pasteMsg, editBlockMsg] = sent
    expect(pasteMsg.payload.type).toBe('paste')
    expect(editBlockMsg.payload.type).toBe('edit_block')
    expect(editBlockMsg.payload.timestamp).toBe(pasteMsg.payload.timestamp)

    const pasteMeta = pasteMsg.payload.meta
    const editMeta = editBlockMsg.payload.meta
    expect(editMeta.source).toBe('external')
    expect(editMeta.position_start).toBe(pasteMeta.position_start)
    expect(editMeta.position_end).toBe(pasteMeta.position_end)
    expect(editMeta.content_before).toBe('')
    expect(editMeta.content_after).toBe('PASTED TEXT')
    expect(editMeta.content_before_length).toBe(0)
    expect(editMeta.content_after_length).toBe(11)
  })

  it('sends only the paste event, with position keys omitted, when the paste cannot be located', async () => {
    __setDocTextForTest('Some unrelated baseline.')
    // Same length as the baseline and doesn't contain the pasted text —
    // both the length-diff path and the lastIndexOf fallback fail.
    global.fetch = () => fakeTextResponse('Some unrelated baseline!')
    const sent = []
    global.chrome.runtime.sendMessage = (msg) => {
      if (msg.action === 'GET_PENDING_AI_OUTPUT') return Promise.resolve({})
      sent.push(msg)
      return Promise.resolve({})
    }

    const promise = emitPaste('UNRELATED PASTE')
    await vi.advanceTimersByTimeAsync(1100)
    await promise

    expect(sent).toHaveLength(1)
    expect(sent[0].payload.type).toBe('paste')
    // position_start:0 (the pre-diff placeholder) must not survive as if it
    // were a real, confirmed position.
    expect('position_start' in sent[0].payload.meta).toBe(false)
    expect('position_end' in sent[0].payload.meta).toBe(false)
  })

  it('sends only the reclassified ai_interaction, no edit_block companion, when the paste matches pending AI output', async () => {
    __setDocTextForTest('Before the paste.')
    global.fetch = () => fakeTextResponse('Before AI OUTPUT HERE the paste.')
    const sent = []
    global.chrome.runtime.sendMessage = (msg) => {
      if (msg.action === 'GET_PENDING_AI_OUTPUT') {
        return Promise.resolve({ text: 'AI OUTPUT HERE', model: 'anthropic/claude' })
      }
      if (msg.action === 'CLEAR_PENDING_AI_OUTPUT') return Promise.resolve({})
      sent.push(msg)
      return Promise.resolve({})
    }

    const promise = emitPaste('AI OUTPUT HERE')
    await vi.advanceTimersByTimeAsync(1100)
    await promise

    const logEvents = sent.filter((m) => m.type === 'LOG_EVENT')
    expect(logEvents).toHaveLength(1)
    expect(logEvents[0].payload.type).toBe('ai_interaction')
  })
})
