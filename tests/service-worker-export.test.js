/**
 * service-worker-export.test.js
 *
 * Regression coverage for exportSession() always preferring the session's
 * stored googleDocId (captured at startSession() time) over a live
 * chrome.tabs.query({active:true}) lookup. Before this fix, a user-initiated
 * export (the popup's "Export" button) always passed docId=null, forcing
 * that live query -- which fails outright if the Google Docs tab is no
 * longer the foreground tab, or has been closed. The background
 * auto-export path already used the stored id; this just stops the button
 * path from being worse off than it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetStore } from './setup.js'
import { startSession, handleMessage } from '../src/background/service-worker.js'

beforeEach(() => {
  resetStore()
  global.chrome.tabs = { query: vi.fn(async () => []) }
  // getXhtmlContentEpub's fetch is mocked to reject deliberately -- these
  // tests only care whether chrome.tabs.query was consulted before that
  // point, not whether a full export succeeds end to end.
  global.fetch = vi.fn(async () => { throw new Error('network unavailable in test') })
})

const DOC_URL = 'https://docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit'

describe('exportSession() docId preference', () => {
  it('never queries the active tab when the session has a stored googleDocId', async () => {
    await startSession({ tabId: 1, docUrl: DOC_URL, title: 'Doc' })

    await handleMessage({ action: 'exportSession' }, {}).catch(() => {})

    expect(global.chrome.tabs.query).not.toHaveBeenCalled()
  })

  it('falls back to the active-tab query for a true legacy session with no stored docId', async () => {
    await startSession({ tabId: 1, title: 'Doc' }) // no docUrl -> no googleDocId captured

    await handleMessage({ action: 'exportSession' }, {}).catch(() => {})

    expect(global.chrome.tabs.query).toHaveBeenCalled()
  })
})
