/**
 * service-worker-pending-ai-output.test.js
 *
 * Regression coverage for _pendingAIOutput persistence: a sidepanel
 * paraphrase/improve quick action sets this (consumed by the next matching
 * paste, to reclassify it as an ai_interaction rather than a plain,
 * un-self-reported paste). It used to be in-memory only, so an MV3 service
 * worker idle-termination between the two — realistic, since the whole
 * point of this flow is the user alt-tabbing out to an AI tool and back —
 * silently lost it.
 *
 * This file can't reload the service-worker.js module to simulate a true
 * SW restart (module state would persist across a re-import within the same
 * test process either way), so it verifies the mechanism directly: setting
 * pending AI output writes through to chrome.storage.local, and clearing it
 * (success or explicit clear) removes it from storage too — the two halves
 * that together mean a real restart's module-scope reset no longer loses
 * the value, since the restore-on-startup code (service-worker.js's
 * _snapshotRestorePromise-style pattern) reads it back from here.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { resetStore } from './setup.js'
import { handleMessage } from '../src/background/service-worker.js'

beforeEach(() => resetStore())

describe('_pendingAIOutput persistence', () => {
  it('SET_PENDING_AI_OUTPUT writes the value to chrome.storage.local, not just memory', async () => {
    await handleMessage({ action: 'SET_PENDING_AI_OUTPUT', payload: { text: 'paraphrased text', subtype: 'paraphrase', model: 'local/llama' } }, {})

    const stored = await chrome.storage.local.get('pendingAIOutput')
    expect(stored.pendingAIOutput?.text).toBe('paraphrased text')
    expect(stored.pendingAIOutput?.model).toBe('local/llama')
    expect(stored.pendingAIOutput?.expiresAt).toBeGreaterThan(Date.now())
  })

  it('GET_PENDING_AI_OUTPUT returns the value and CLEAR_PENDING_AI_OUTPUT removes it from storage', async () => {
    await handleMessage({ action: 'SET_PENDING_AI_OUTPUT', payload: { text: 'draft', subtype: 'draft', model: 'local/llama' } }, {})
    const got = await handleMessage({ action: 'GET_PENDING_AI_OUTPUT' }, {})
    expect(got.text).toBe('draft')

    await handleMessage({ action: 'CLEAR_PENDING_AI_OUTPUT' }, {})
    const stored = await chrome.storage.local.get('pendingAIOutput')
    expect(stored.pendingAIOutput).toBeUndefined()
  })

  it('GET_PENDING_AI_OUTPUT can be checked more than once before CLEAR_PENDING_AI_OUTPUT (not one-shot)', async () => {
    await handleMessage({ action: 'SET_PENDING_AI_OUTPUT', payload: { text: 'draft', subtype: 'draft', model: 'local/llama' } }, {})
    const first = await handleMessage({ action: 'GET_PENDING_AI_OUTPUT' }, {})
    const second = await handleMessage({ action: 'GET_PENDING_AI_OUTPUT' }, {})
    expect(first.text).toBe('draft')
    expect(second.text).toBe('draft')
  })
})
