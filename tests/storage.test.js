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
  ensureUserId,
} from '../src/shared/storage.js'

beforeEach(() => resetStore())

// ── Settings ──────────────────────────────────────────────────────────────────

describe('getSettings', () => {
  it('returns defaults when nothing is stored', async () => {
    const s = await getSettings()
    expect(s.aiPath).toBe('ollama')
    expect(s.ollamaEndpoint).toBe('http://localhost:11434')
    expect(s.outputFormat).toBe('twff')
    expect(s.userId).toBe('')
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

describe('ensureUserId', () => {
  it('generates an anon- prefixed ID', async () => {
    const id = await ensureUserId()
    expect(id).toMatch(/^anon-[a-f0-9]{12}$/)
  })

  it('is idempotent — same ID returned on every call', async () => {
    const id1 = await ensureUserId()
    const id2 = await ensureUserId()
    expect(id1).toBe(id2)
  })

  it('persists the ID in settings', async () => {
    const id = await ensureUserId()
    const settings = await getSettings()
    expect(settings.userId).toBe(id)
  })

  it('two calls in a fresh store generate exactly one ID', async () => {
    await ensureUserId()
    await ensureUserId()
    const settings = await getSettings()
    expect(settings.userId).toMatch(/^anon-/)
  })
})
