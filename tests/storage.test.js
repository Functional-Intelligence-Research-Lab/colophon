/**
 * storage.test.js
 *
 * Tests for src/shared/storage.js — chrome.storage.local wrappers.
 * chrome is mocked in tests/setup.js with an in-memory store.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { resetStore } from './setup.js'
import {
  getSettings,
  saveSettings,
  getSession,
  saveSession,
  clearSession,
  generateUserId,
  ensureSessionUserId,
} from '../src/shared/storage.js'

beforeEach(() => resetStore())

// ── Settings ──────────────────────────────────────────────────────────────────

describe('getSettings', () => {
  it('returns defaults when nothing is stored', async () => {
    const s = await getSettings()
    expect(s.aiPath).toBe('ollama')
    expect(s.ollamaEndpoint).toBe('http://localhost:11434')
    expect(s.outputFormat).toBe('twff')
  })
})

describe('saveSettings', () => {
  it('persists a partial update without clearing other defaults', async () => {
    await saveSettings({ aiPath: 'gemini-native' })
    const s = await getSettings()
    expect(s.aiPath).toBe('gemini-native')
    expect(s.ollamaEndpoint).toBe('http://localhost:11434') // unchanged default
  })

  it('successive saves accumulate correctly', async () => {
    await saveSettings({ aiPath: 'gemini-native' })
    await saveSettings({ ollamaModel: 'qwen2.5:0.5b' })
    const s = await getSettings()
    expect(s.aiPath).toBe('gemini-native')
    expect(s.ollamaModel).toBe('qwen2.5:0.5b')
  })
})

// ── Session ───────────────────────────────────────────────────────────────────

describe('getSession', () => {
  it('returns null when nothing stored', async () => {
    expect(await getSession()).toBeNull()
  })
})

describe('saveSession / clearSession', () => {
  it('round-trips a session object', async () => {
    const session = {
      sessionId: 'test-uuid',
      startedAt: '2026-04-29T10:00:00.000Z',
      isRecording: true,
      events: [],
    }
    await saveSession(session)
    expect(await getSession()).toEqual(session)
  })

  it('clearSession removes session from storage', async () => {
    await saveSession({ sessionId: 'x', events: [] })
    await clearSession()
    expect(await getSession()).toBeNull()
  })
})

// ── User ID ───────────────────────────────────────────────────────────────────

describe('generateUserId', () => {
  it('generates an anon- prefixed ID', async () => {
    const id = await generateUserId()
    expect(id).toMatch(/^anon-[a-f0-9]{12}$/)
  })

  it('generates a different ID on every call — no persistence, no reuse', async () => {
    const id1 = await generateUserId()
    const id2 = await generateUserId()
    expect(id1).not.toBe(id2)
  })
})

describe('ensureSessionUserId', () => {
  it('attaches a fresh anon- ID to a session that has none', async () => {
    const session = { sessionId: 'a', events: [] }
    const id = await ensureSessionUserId(session)
    expect(id).toMatch(/^anon-[a-f0-9]{12}$/)
    expect(session.userId).toBe(id)
  })

  it('is idempotent within one session — same ID returned on every call', async () => {
    const session = { sessionId: 'a', events: [] }
    const id1 = await ensureSessionUserId(session)
    const id2 = await ensureSessionUserId(session)
    expect(id1).toBe(id2)
  })

  it('two different session objects get two different IDs — rotates per session', async () => {
    const sessionA = { sessionId: 'a', events: [] }
    const sessionB = { sessionId: 'b', events: [] }
    const idA = await ensureSessionUserId(sessionA)
    const idB = await ensureSessionUserId(sessionB)
    expect(idA).not.toBe(idB)
  })
})
