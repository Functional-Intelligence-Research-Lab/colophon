/**
 * tests/setup.js — global test setup
 *
 * Provides a minimal in-memory mock of chrome.storage.local so that
 * storage.js can be imported and tested without a real browser.
 * Each test file gets a fresh store via beforeEach.
 */

let _store = {}

export function resetStore() {
  _store = {}
}

global.chrome = {
  storage: {
    local: {
      get(keys) {
        if (typeof keys === 'string') {
          return Promise.resolve({ [keys]: _store[keys] })
        }
        const result = {}
        const ks = Array.isArray(keys) ? keys : Object.keys(keys)
        for (const k of ks) result[k] = _store[k]
        return Promise.resolve(result)
      },
      set(items) {
        Object.assign(_store, items)
        return Promise.resolve()
      },
      remove(keys) {
        const ks = Array.isArray(keys) ? keys : [keys]
        for (const k of ks) delete _store[k]
        return Promise.resolve()
      },
    },
  },
}
