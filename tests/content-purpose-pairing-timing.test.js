/**
 * content-purpose-pairing-timing.test.js
 *
 * The purpose checkbox (content.js's showPasteSourcePrompt) must mark BOTH
 * the paste event and its paired edit_block(source:'external') -- but the
 * edit_block is only actually built and sent ~1000ms later, inside
 * emitPaste()'s delayed setTimeout, and only when a position was located.
 * A naive "update the paired event once its id is known" design is
 * race-prone: the popup is clickable immediately, well before that 1000ms
 * mark. The real fix pre-assigns the edit_block's event_id atomically with
 * the paste's own id (before either is sent), and relies on
 * UPDATE_EVENT_METADATA's existing bounded retry (service-worker.js's
 * METADATA_UPDATE_RETRY_DELAYS_MS, up to ~1.1s) to catch either event
 * whether it's already logged or still on its way. This file drives the
 * real emitPaste() + showPasteSourcePrompt() together (not emitPaste alone,
 * as content-paste-pairing.test.js does, and not the popup alone, as
 * paste-prompt.test.js does) to prove both actual, distinguishable
 * orderings the real code can produce.
 *
 * Note: there is no real third ordering ("after the paste is sent but
 * before the paired edit_block") to test -- both sends happen synchronously,
 * back to back with no await between them, inside the same setTimeout
 * callback. The two orderings below are the only ones the real code can
 * actually produce.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resetStore } from './setup.js'
import { emitPaste, __setDocTextForTest } from '../src/content/content.js'

function fakeTextResponse(text) {
  return Promise.resolve({ ok: true, text: () => Promise.resolve(text) })
}

// Same MockElement shim as paste-prompt.test.js, duplicated rather than
// imported since it's test-local setup, not production code.
class MockElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.id = ''
    this.style = {}
    this.dataset = {}
    this.attributes = {}
    this.children = []
    this.parentNode = null
    this.textContent = ''
    this.listeners = {}
  }
  setAttribute(k, v) { this.attributes[k] = v; if (k === 'id') this.id = v }
  getAttribute(k) { return this.attributes[k] }
  append(...children) { for (const c of children) { c.parentNode = this; this.children.push(c) } }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) { this.children.splice(i, 1); c.parentNode = null } }
  replaceChildren(...newChildren) { this.children = []; this.append(...newChildren) }
  addEventListener(event, handler) { (this.listeners[event] ??= []).push(handler) }
  dispatchEvent(event) { (this.listeners[event.type] || []).forEach(h => h(event)) }
  click() { this.dispatchEvent({ type: 'click' }) }
}

let mockBody

beforeEach(() => {
  resetStore()
  vi.useFakeTimers()
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
  mockBody = new MockElement('body')
  global.document = {
    body: mockBody,
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => {
      function search(el) {
        if (el.id === id) return el
        for (const c of el.children) { const found = search(c); if (found) return found }
        return null
      }
      return search(mockBody)
    },
  }
})

afterEach(() => {
  delete global.document
  delete global.requestAnimationFrame
})

function findPurposeCheckbox(host) {
  // purposeRow is appended last: host.children = [topRow, chipContainer, purposeRow]
  return host.children[2].children[0]
}

describe('purpose checkbox + emitPaste — atomic pairing across real timing', () => {
  it('checked BEFORE the delayed paired edit_block is emitted: both events end up marked', async () => {
    __setDocTextForTest('Before the paste.')
    global.fetch = () => fakeTextResponse('Before PASTED TEXT the paste.')
    const sentMessages = []
    global.chrome.runtime.sendMessage = (msg) => {
      if (msg.action === 'GET_PENDING_AI_OUTPUT') return Promise.resolve({})
      sentMessages.push(msg)
      return Promise.resolve({ status: 'success' })
    }

    const promise = emitPaste('PASTED TEXT')
    // The popup renders synchronously inside emitPaste, before the 1000ms
    // delay -- check it now, well before either event has been sent.
    const host = global.document.getElementById('colophon-paste-tag-prompt')
    const checkbox = findPurposeCheckbox(host)
    checkbox.checked = true
    checkbox.dispatchEvent({ type: 'change' })

    await vi.advanceTimersByTimeAsync(1100)
    await promise

    const logEvents = sentMessages.filter(m => m.type === 'LOG_EVENT')
    const updateCalls = sentMessages.filter(m => m.type === 'UPDATE_EVENT_METADATA')

    const pasteMsg = logEvents.find(m => m.payload.type === 'paste')
    const editBlockMsg = logEvents.find(m => m.payload.type === 'edit_block')
    expect(pasteMsg).toBeTruthy()
    expect(editBlockMsg).toBeTruthy()

    const updatedIds = updateCalls.map(m => m.payload.eventId)
    expect(updatedIds).toContain(pasteMsg.payload.event_id)
    expect(updatedIds).toContain(editBlockMsg.payload.event_id)
    expect(updateCalls.every(m => m.payload.key === 'purpose' && m.payload.value === 'study_stimulus_seed')).toBe(true)
  })

  it('checked AFTER both events already exist: both updates target real, already-sent event ids', async () => {
    __setDocTextForTest('Before the paste.')
    global.fetch = () => fakeTextResponse('Before PASTED TEXT the paste.')
    const sentMessages = []
    global.chrome.runtime.sendMessage = (msg) => {
      if (msg.action === 'GET_PENDING_AI_OUTPUT') return Promise.resolve({})
      sentMessages.push(msg)
      return Promise.resolve({ status: 'success' })
    }

    const promise = emitPaste('PASTED TEXT')
    const host = global.document.getElementById('colophon-paste-tag-prompt')
    const checkbox = findPurposeCheckbox(host)

    // Both LOG_EVENT sends happen here, before the checkbox is touched.
    await vi.advanceTimersByTimeAsync(1100)
    await promise

    checkbox.checked = true
    checkbox.dispatchEvent({ type: 'change' })
    await Promise.resolve() // let the async change handler's sendMessage calls settle

    const logEvents = sentMessages.filter(m => m.type === 'LOG_EVENT')
    const updateCalls = sentMessages.filter(m => m.type === 'UPDATE_EVENT_METADATA')
    const pasteMsg = logEvents.find(m => m.payload.type === 'paste')
    const editBlockMsg = logEvents.find(m => m.payload.type === 'edit_block')

    const updatedIds = updateCalls.map(m => m.payload.eventId)
    expect(updatedIds).toContain(pasteMsg.payload.event_id)
    expect(updatedIds).toContain(editBlockMsg.payload.event_id)
  })

  it('an unlocatable paste (no paired edit_block ever sent) still marks the paste alone, harmlessly', async () => {
    __setDocTextForTest('Some unrelated baseline.')
    global.fetch = () => fakeTextResponse('Some unrelated baseline!')
    const sentMessages = []
    global.chrome.runtime.sendMessage = (msg) => {
      if (msg.action === 'GET_PENDING_AI_OUTPUT') return Promise.resolve({})
      sentMessages.push(msg)
      if (msg.type === 'UPDATE_EVENT_METADATA') {
        // Simulate the real service worker: only the paste's id is ever
        // found, since no edit_block was ever appended.
        const pasteMsg = sentMessages.find(m => m.type === 'LOG_EVENT' && m.payload.type === 'paste')
        const found = pasteMsg && msg.payload.eventId === pasteMsg.payload.event_id
        return Promise.resolve(found ? { status: 'success' } : { status: 'error', reason: 'event not found' })
      }
      return Promise.resolve({})
    }

    const promise = emitPaste('UNRELATED PASTE')
    const host = global.document.getElementById('colophon-paste-tag-prompt')
    const checkbox = findPurposeCheckbox(host)
    checkbox.checked = true
    checkbox.dispatchEvent({ type: 'change' })

    await vi.advanceTimersByTimeAsync(1100)
    await promise
    await Promise.resolve()

    const logEvents = sentMessages.filter(m => m.type === 'LOG_EVENT')
    expect(logEvents).toHaveLength(1) // paste only, no edit_block
    expect(logEvents[0].payload.type).toBe('paste')
  })
})
