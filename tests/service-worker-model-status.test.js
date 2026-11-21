/**
 * service-worker-model-status.test.js
 *
 * Regression coverage for CHECK_MODEL_STATUS's server-identity check. Before
 * this fix, the handler treated any 2xx response on the stored llamafile
 * port as proof the model was "running" -- it never checked the response
 * body at all. An unrelated local service squatting on the same port (e.g.
 * after a reboot, before llamafile relaunched there) that happens to answer
 * GET /health with any 2xx status got misidentified as the real server.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetStore } from './setup.js'
import { handleMessage } from '../src/background/service-worker.js'

beforeEach(() => {
  resetStore()
  global.fetch = vi.fn()
})

describe('CHECK_MODEL_STATUS server-identity check', () => {
  it('reports "running" when the health response has the real llamafile shape', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'ok', slots_idle: 1, slots_processing: 0 }),
    }))

    const result = await handleMessage({ action: 'CHECK_MODEL_STATUS' }, {})

    expect(result.status).toBe('running')
  })

  it('reports "port_conflict", not "running", when something else answers 2xx with a different shape', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ hello: 'world' }), // some unrelated local service
    }))

    const result = await handleMessage({ action: 'CHECK_MODEL_STATUS' }, {})

    expect(result.status).toBe('port_conflict')
    expect(result.status).not.toBe('running')
  })

  it('reports "port_conflict" when the 2xx response body is not JSON at all', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => { throw new Error('not json') },
    }))

    const result = await handleMessage({ action: 'CHECK_MODEL_STATUS' }, {})

    expect(result.status).toBe('port_conflict')
  })

  it('does not report "running" when the connection is refused (nothing listening)', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('fetch failed') })

    const result = await handleMessage({ action: 'CHECK_MODEL_STATUS' }, {})

    expect(result.status).not.toBe('running')
    expect(result.status).not.toBe('port_conflict')
  })
})
