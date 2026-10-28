import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { showPasteSourcePrompt, dismissPasteSourcePrompt } from '../src/content/content.js'
import { SOURCE_TOOLS } from '../src/shared/source-tools.js'

describe('Paste Source Tagging UI Prompt', () => {
  let mockBody
  let sentMessages = []

  beforeEach(() => {
    sentMessages = []
    global.chrome.runtime.sendMessage = vi.fn((msg) => {
      sentMessages.push(msg)
      return Promise.resolve({ ok: true })
    })

    const elements = new Map()

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

      setAttribute(k, v) {
        this.attributes[k] = v
        if (k === 'id') this.id = v
      }

      getAttribute(k) {
        return this.attributes[k]
      }

      append(...children) {
        for (const c of children) {
          c.parentNode = this
          this.children.push(c)
        }
      }

      appendChild(c) {
        c.parentNode = this
        this.children.push(c)
        return c
      }

      removeChild(c) {
        const idx = this.children.indexOf(c)
        if (idx !== -1) {
          this.children.splice(idx, 1)
          c.parentNode = null
        }
      }

      replaceChildren(...newChildren) {
        this.children = []
        this.append(...newChildren)
      }

      addEventListener(event, handler) {
        if (!this.listeners[event]) this.listeners[event] = []
        this.listeners[event].push(handler)
      }

      dispatchEvent(event) {
        const handlers = this.listeners[event.type] || []
        handlers.forEach(h => h(event))
      }

      click() {
        this.dispatchEvent({ type: 'click' })
      }
    }

    mockBody = new MockElement('body')

    global.document = {
      body: mockBody,
      createElement: (tag) => new MockElement(tag),
      getElementById: (id) => {
        function search(el) {
          if (el.id === id) return el
          for (const c of el.children) {
            const found = search(c)
            if (found) return found
          }
          return null
        }
        return search(mockBody)
      },
    }

    global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
  })

  afterEach(() => {
    delete global.document
    delete global.requestAnimationFrame
  })

  it('renders prompt element with role and aria-label', () => {
    const pasteEvt = {
      timestamp: '2026-10-15T10:00:00.000Z',
      type: 'paste',
      meta: { char_count: 50 },
    }

    const host = showPasteSourcePrompt(pasteEvt)
    expect(host).toBeDefined()
    expect(host.id).toBe('colophon-paste-tag-prompt')
    expect(host.getAttribute('role')).toBe('region')
    expect(host.getAttribute('aria-label')).toBe('Self-report pasted text source')
  })

  it('renders buttons for all fixed tools', () => {
    const pasteEvt = {
      timestamp: '2026-10-15T10:00:00.000Z',
      type: 'paste',
      meta: { char_count: 50 },
    }

    const host = showPasteSourcePrompt(pasteEvt)
    // Find chip container
    const chipsContainer = host.children[1]
    expect(chipsContainer.children.length).toBe(SOURCE_TOOLS.length)

    const renderedToolIds = chipsContainer.children.map(b => b.dataset.toolId)
    expect(renderedToolIds).toEqual(SOURCE_TOOLS.map(t => t.id))
  })

  it('tags paste event and sends UPDATE_EVENT_METADATA keyed by the real event_id, not the timestamp', () => {
    // emitPaste() now assigns a real event_id at creation time (see
    // content.js) specifically so this handler never needs to fall back to
    // a timestamp match, which could collide with a different paste
    // landing in the same millisecond.
    const pasteEvt = {
      event_id: 'real-event-id-123',
      timestamp: '2026-10-15T10:00:00.000Z',
      type: 'paste',
      meta: { char_count: 50 },
    }

    const host = showPasteSourcePrompt(pasteEvt)
    const chipsContainer = host.children[1]
    const claudeBtn = chipsContainer.children.find(b => b.dataset.toolId === 'claude')

    claudeBtn.click()

    expect(pasteEvt.meta.source_tool).toBe('claude')
    expect(sentMessages).toContainEqual({
      type: 'UPDATE_EVENT_METADATA',
      payload: {
        eventId: 'real-event-id-123',
        key: 'source_tool',
        value: 'claude',
        via: 'paste_prompt',
      },
    })
  })

  it('marks the paste as the study stimulus seed independently of any source_tool chip, keyed by the real event_id', () => {
    // purpose answers "why was this pasted," not "where did it come from"
    // (source_tool's job) -- a separate row, not a chip, so it's checkable
    // in either order relative to a source_tool pick. See twff/spec/
    // SPEC.md's `purpose` field.
    const pasteEvt = {
      event_id: 'real-event-id-456',
      timestamp: '2026-10-15T10:00:00.000Z',
      type: 'paste',
      meta: { char_count: 50 },
    }

    const host = showPasteSourcePrompt(pasteEvt)
    const purposeRow = host.children[2]
    const purposeCheckbox = purposeRow.children[0]

    purposeCheckbox.checked = true
    purposeCheckbox.dispatchEvent({ type: 'change' })

    expect(pasteEvt.meta.purpose).toBe('study_stimulus_seed')
    expect(sentMessages).toContainEqual({
      type: 'UPDATE_EVENT_METADATA',
      payload: {
        eventId: 'real-event-id-456',
        key: 'purpose',
        value: 'study_stimulus_seed',
        via: 'paste_prompt',
      },
    })
    // Independent of source_tool -- neither chip-click nor checkbox should
    // ever set the other field.
    expect(pasteEvt.meta.source_tool).toBeUndefined()
  })

  it('a source_tool chip click never sets purpose, and checking the purpose box never sets source_tool', () => {
    const pasteEvt = {
      event_id: 'real-event-id-789',
      timestamp: '2026-10-15T10:00:00.000Z',
      type: 'paste',
      meta: { char_count: 50 },
    }

    const host = showPasteSourcePrompt(pasteEvt)
    const chipsContainer = host.children[1]
    const claudeBtn = chipsContainer.children.find(b => b.dataset.toolId === 'claude')
    claudeBtn.click()

    expect(pasteEvt.meta.source_tool).toBe('claude')
    expect(pasteEvt.meta.purpose).toBeUndefined()
  })

  it('does not re-send purpose if the checkbox change fires again without being unchecked first', () => {
    const pasteEvt = {
      event_id: 'real-event-id-999',
      timestamp: '2026-10-15T10:00:00.000Z',
      type: 'paste',
      meta: { char_count: 50 },
    }

    const host = showPasteSourcePrompt(pasteEvt)
    const purposeRow = host.children[2]
    const purposeCheckbox = purposeRow.children[0]

    purposeCheckbox.checked = true
    purposeCheckbox.dispatchEvent({ type: 'change' })
    expect(purposeCheckbox.disabled).toBe(true)
  })

  it('omits source_tool when dismissed via close button (skipped tagging)', () => {
    const pasteEvt = {
      timestamp: '2026-10-15T10:00:00.000Z',
      type: 'paste',
      meta: { char_count: 50 },
    }

    const host = showPasteSourcePrompt(pasteEvt)
    const topRow = host.children[0]
    const closeBtn = topRow.children[1]

    closeBtn.click()

    // source_tool was NOT set
    expect(pasteEvt.meta.source_tool).toBeUndefined()
  })

  it('safely handles missing document or body', () => {
    delete global.document.body
    const pasteEvt = { timestamp: '2026-10-15T10:00:00.000Z', type: 'paste', meta: {} }
    expect(() => showPasteSourcePrompt(pasteEvt)).not.toThrow()
    expect(showPasteSourcePrompt(pasteEvt)).toBeNull()
  })
})

