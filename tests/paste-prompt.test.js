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

  it('tags paste event and sends UPDATE_EVENT_METADATA when a tool chip is clicked', () => {
    const pasteEvt = {
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
        eventTimestamp: '2026-10-15T10:00:00.000Z',
        key: 'source_tool',
        value: 'claude',
      },
    })
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
