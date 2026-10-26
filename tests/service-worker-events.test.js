/**
 * service-worker-events.test.js
 *
 * Regression coverage for two bugs fixed this round in
 * src/background/service-worker.js:
 *
 *   1. Cross-document event bleed: opening a second Google Docs tab while
 *      another was already auto-recording used to silently attach the
 *      second doc's real events to the first doc's session.
 *   2. Timestamp-as-event-ID collisions: UPDATE_EVENT_ACCEPTANCE/_METADATA/
 *      _STATE used to look events up by exact-string `timestamp` match, with
 *      no real unique ID — two events sharing a millisecond (a real,
 *      reachable case) meant acting on one could silently mutate the other.
 *      event_id (assigned by pushEvent()) plus the metadata-update retry
 *      (covering the silent paste-tag-drop race) are both covered here too.
 *
 * chrome.tabs/chrome.scripting are deliberately left unmocked beyond
 * tests/setup.js's defaults — activateContentScript() already degrades
 * gracefully (try/catch to a console.warn) when they're absent, so a real
 * tabId can be exercised here without adding browser-tab simulation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetStore } from './setup.js'
import {
  startSession,
  autoStartSession,
  appendEvent,
  pushEvent,
  findEventByRef,
  updateEventMetadata,
  updateEventAcceptance,
  updateEventState,
} from '../src/background/service-worker.js'
import { getSession } from '../src/shared/storage.js'

beforeEach(() => resetStore())

const DOC_A = 'https://docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit'
const DOC_B = 'https://docs.google.com/document/d/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/edit'

describe('cross-document event bleed', () => {
  it('autoStartSession switches the active session when a second doc opens', async () => {
    const a = await autoStartSession({ tab: { id: 1, url: DOC_A, title: 'Doc A' } })
    expect(a.ok).toBe(true)

    const sessionAfterA = await getSession()
    expect(sessionAfterA.docId).toBeTruthy()
    const docIdA = sessionAfterA.docId

    // A second, different doc opens (e.g. a new tab) while A is still
    // "recording" — autoStartSession used to just check `isRecording` and
    // reattach to A's session unconditionally, never switching to B at all.
    const b = await autoStartSession({ tab: { id: 2, url: DOC_B, title: 'Doc B' } })
    expect(b.ok).toBe(true)

    const sessionAfterB = await getSession()
    expect(sessionAfterB.docId).not.toBe(docIdA)
    expect(sessionAfterB.tabId).toBe(2)
  })

  it('appendEvent rejects an event from a tab that is not the active session\'s tab', async () => {
    await autoStartSession({ tab: { id: 1, url: DOC_A, title: 'Doc A' } })
    // Doc B becomes active; doc A's tab (1) is now in the background.
    await autoStartSession({ tab: { id: 2, url: DOC_B, title: 'Doc B' } })

    const staleEventFromDocA = { timestamp: new Date().toISOString(), type: 'edit_block', meta: { char_delta: 5 } }
    const result = await appendEvent(staleEventFromDocA, { tab: { id: 1 } })
    expect(result.ok).toBe(false)

    // Confirm it was never actually attached to B's session.
    const session = await getSession()
    expect(session.events.some(e => e.type === 'edit_block')).toBe(false)
  })

  it('appendEvent accepts an event from the active session\'s own tab', async () => {
    await autoStartSession({ tab: { id: 2, url: DOC_B, title: 'Doc B' } })
    const realEvent = { timestamp: new Date().toISOString(), type: 'edit_block', meta: { char_delta: 5 } }
    const result = await appendEvent(realEvent, { tab: { id: 2 } })
    expect(result.ok).toBe(true)

    const session = await getSession()
    expect(session.events.some(e => e.type === 'edit_block')).toBe(true)
  })
})

describe('event_id — real identity vs. the proven timestamp collision', () => {
  it('pushEvent assigns a unique event_id even to two events sharing the same timestamp', () => {
    const session = { events: [] }
    const sharedTs = '2026-01-01T00:00:00.000Z'
    pushEvent(session, { timestamp: sharedTs, type: 'heuristic_suggestion', meta: { rule: 'passive_voice' } })
    pushEvent(session, { timestamp: sharedTs, type: 'heuristic_suggestion', meta: { rule: 'wordy_phrase' } })

    expect(session.events).toHaveLength(2)
    expect(session.events[0].event_id).toBeTruthy()
    expect(session.events[1].event_id).toBeTruthy()
    expect(session.events[0].event_id).not.toBe(session.events[1].event_id)
  })

  it('findEventByRef disambiguates same-timestamp events by event_id, not just by timestamp', () => {
    const sharedTs = '2026-01-01T00:00:00.000Z'
    const session = { events: [] }
    pushEvent(session, { timestamp: sharedTs, type: 'heuristic_suggestion', meta: { rule: 'passive_voice' } })
    pushEvent(session, { timestamp: sharedTs, type: 'heuristic_suggestion', meta: { rule: 'wordy_phrase' } })

    const second = session.events[1]
    const found = findEventByRef(session, second.event_id)
    expect(found).toBe(second)
    expect(found.meta.rule).toBe('wordy_phrase')
  })

  it('findEventByRef falls back to a timestamp match for events that predate event_id', () => {
    const session = { events: [{ timestamp: '2026-01-01T00:00:00.000Z', type: 'paste', meta: {} }] }
    const found = findEventByRef(session, '2026-01-01T00:00:00.000Z')
    expect(found).toBe(session.events[0])
  })
})

describe('updateEventMetadata retry (silent paste-tag-drop race)', () => {
  it('succeeds once the event exists, even if a first lookup pass would have missed it', async () => {
    await autoStartSession({ tab: { id: 1, url: DOC_A, title: 'Doc A' } })
    const pasteEvent = { timestamp: '2026-02-02T00:00:00.000Z', type: 'paste', meta: { char_count: 10 } }
    await appendEvent(pasteEvent, { tab: { id: 1 } })

    const result = await updateEventMetadata({ eventId: '2026-02-02T00:00:00.000Z', key: 'source_tool', value: 'claude' })
    expect(result.status).toBe('success')

    const session = await getSession()
    const stored = session.events.find(e => e.type === 'paste')
    expect(stored.meta.source_tool).toBe('claude')
  })

  it('returns a real error (not a false success) when the event never appears', async () => {
    await autoStartSession({ tab: { id: 1, url: DOC_A, title: 'Doc A' } })
    const result = await updateEventMetadata({ eventId: 'does-not-exist', key: 'source_tool', value: 'claude' })
    expect(result.status).toBe('error')
  }, 10000)
})

describe('updateEventMetadata — source_tool correction history', () => {
  it('records a history entry (not just an overwrite) the second time source_tool is set', async () => {
    await autoStartSession({ tab: { id: 1, url: DOC_A, title: 'Doc A' } })
    const pasteEvent = { timestamp: '2026-02-02T00:00:00.000Z', type: 'paste', meta: { char_count: 10 } }
    await appendEvent(pasteEvent, { tab: { id: 1 } })

    await updateEventMetadata({ eventId: '2026-02-02T00:00:00.000Z', key: 'source_tool', value: 'chatgpt', via: 'paste_prompt' })
    await updateEventMetadata({ eventId: '2026-02-02T00:00:00.000Z', key: 'source_tool', value: 'claude', via: 'sidepanel' })

    const session = await getSession()
    const stored = session.events.find(e => e.type === 'paste')
    expect(stored.meta.source_tool).toBe('claude') // always mirrors the latest entry
    expect(stored.meta.source_tool_history).toHaveLength(2)
    expect(stored.meta.source_tool_history[0]).toMatchObject({ value: 'chatgpt', via: 'paste_prompt' })
    expect(stored.meta.source_tool_history[1]).toMatchObject({ value: 'claude', via: 'sidepanel' })
  })

  it('does not create a history array on the first, one-time set', async () => {
    await autoStartSession({ tab: { id: 1, url: DOC_A, title: 'Doc A' } })
    const pasteEvent = { timestamp: '2026-02-02T00:00:00.000Z', type: 'paste', meta: { char_count: 10 } }
    await appendEvent(pasteEvent, { tab: { id: 1 } })

    await updateEventMetadata({ eventId: '2026-02-02T00:00:00.000Z', key: 'source_tool', value: 'claude', via: 'paste_prompt' })

    const session = await getSession()
    const stored = session.events.find(e => e.type === 'paste')
    expect(stored.meta.source_tool_history).toHaveLength(1)
  })

  it('does not append a history entry for an unrelated metadata key', async () => {
    await autoStartSession({ tab: { id: 1, url: DOC_A, title: 'Doc A' } })
    const pasteEvent = { timestamp: '2026-02-02T00:00:00.000Z', type: 'paste', meta: { char_count: 10 } }
    await appendEvent(pasteEvent, { tab: { id: 1 } })

    await updateEventMetadata({ eventId: '2026-02-02T00:00:00.000Z', key: 'source_url', value: 'https://example.test' })

    const session = await getSession()
    const stored = session.events.find(e => e.type === 'paste')
    expect(stored.meta.source_tool_history).toBeUndefined()
  })
})

describe('updateEventAcceptance — honest success/failure (was always {status:"success"})', () => {
  it('succeeds and writes acceptance/similarity_score when the event exists', async () => {
    await autoStartSession({ tab: { id: 1, url: DOC_A, title: 'Doc A' } })
    const interactionEvent = { timestamp: '2026-04-01T00:00:00.000Z', type: 'ai_interaction', meta: { acceptance: 'rejected' } }
    await appendEvent(interactionEvent, { tab: { id: 1 } })

    const result = await updateEventAcceptance({ eventId: '2026-04-01T00:00:00.000Z', acceptance: 'fully_accepted', similarity_score: 0.95 })
    expect(result.status).toBe('success')

    const session = await getSession()
    const stored = session.events.find(e => e.type === 'ai_interaction')
    expect(stored.meta.acceptance).toBe('fully_accepted')
    expect(stored.meta.similarity_score).toBe(0.95)
  })

  it('returns a real error (not a false success) when the event never appears', async () => {
    await autoStartSession({ tab: { id: 1, url: DOC_A, title: 'Doc A' } })
    const result = await updateEventAcceptance({ eventId: 'does-not-exist', acceptance: 'fully_accepted' })
    expect(result.status).toBe('error')
  }, 10000)
})

describe('session read-modify-write lock (storage-compaction lost-update race)', () => {
  it('two concurrent mutations to different events both survive, neither silently discarded', async () => {
    await autoStartSession({ tab: { id: 1, url: DOC_A, title: 'Doc A' } })
    const eventOne = { timestamp: '2026-03-01T00:00:00.000Z', type: 'paste', meta: { char_count: 5 } }
    const eventTwo = { timestamp: '2026-03-01T00:00:01.000Z', type: 'heuristic_suggestion', meta: { rule: 'passive_voice' } }
    await appendEvent(eventOne, { tab: { id: 1 } })
    await appendEvent(eventTwo, { tab: { id: 1 } })

    const sessionBefore = await getSession()
    const idOne = sessionBefore.events.find(e => e.type === 'paste').event_id
    const idTwo = sessionBefore.events.find(e => e.type === 'heuristic_suggestion').event_id

    // Fired concurrently, not sequentially — each does its own
    // getSession()/saveSession() read-modify-write cycle. Without the lock
    // serializing them, whichever saveSession() call lands second
    // completely replaces the stored session, discarding the other's
    // change (chrome.storage.local.set() has no partial-merge semantics).
    await Promise.all([
      updateEventMetadata({ eventId: idOne, key: 'source_tool', value: 'claude' }),
      updateEventState({ eventId: idTwo, status: 'dismissed' }),
    ])

    const sessionAfter = await getSession()
    const pasteEvent = sessionAfter.events.find(e => e.event_id === idOne)
    const suggestionEvent = sessionAfter.events.find(e => e.event_id === idTwo)
    expect(pasteEvent.meta.source_tool).toBe('claude')
    expect(suggestionEvent.meta.status).toBe('dismissed')
  })
})
