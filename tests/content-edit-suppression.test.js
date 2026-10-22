/**
 * content-edit-suppression.test.js
 *
 * Regression coverage for: typing immediately after a paste/AI-accept used
 * to silently lose up to 1.5s of real keystrokes. bufferEdit()'s paste-echo
 * suppression window (meant to stop the MutationObserver path from double-
 * logging a paste's own DOM insertion) used to apply unconditionally, even
 * to keydown-sourced calls — which can never be a paste echo, since Google
 * Docs' canvas renderer means typing never touches the visible DOM at all
 * (see content.js's header comment).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetStore } from './setup.js'
import { bufferEdit, flushEdit, __setLastPasteAtForTest } from '../src/content/content.js'

beforeEach(() => {
  resetStore()
  vi.useFakeTimers()
})

describe('bufferEdit — paste-suppression exemption for real keystrokes', () => {
  it('suppresses a mutation-sourced delta within the paste-echo window', () => {
    __setLastPasteAtForTest(Date.now())
    const sent = []
    global.chrome.runtime.sendMessage = (msg) => { sent.push(msg); return Promise.resolve({}) }

    bufferEdit(5) // no fromKeydown flag — same call shape as onMutation()
    vi.advanceTimersByTime(1100) // DEBOUNCE_MS

    expect(sent).toHaveLength(0)
  })

  it('does NOT suppress a real keydown-sourced delta during the same window', () => {
    __setLastPasteAtForTest(Date.now())
    const sent = []
    global.chrome.runtime.sendMessage = (msg) => { sent.push(msg); return Promise.resolve({}) }

    bufferEdit(1, false, { fromKeydown: true })
    vi.advanceTimersByTime(1100)

    expect(sent).toHaveLength(1)
    expect(sent[0].payload.meta.char_delta).toBe(1)
  })

  it('resumes buffering mutation-sourced deltas once the window has passed', () => {
    __setLastPasteAtForTest(Date.now() - 2000) // well past PASTE_SUPPRESSION_MS (1500ms)
    const sent = []
    global.chrome.runtime.sendMessage = (msg) => { sent.push(msg); return Promise.resolve({}) }

    bufferEdit(3)
    vi.advanceTimersByTime(1100)

    expect(sent).toHaveLength(1)
    expect(sent[0].payload.meta.char_delta).toBe(3)
  })
})
