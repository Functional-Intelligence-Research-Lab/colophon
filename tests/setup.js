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

global.location = {
  pathname: '/document/d/test/edit',
  href: 'https://docs.google.com/document/d/test/edit',
}

global.window = {
  location: global.location,
  addEventListener: () => {},
  removeEventListener: () => {},
  getSelection: () => ({
    toString: () => '',
    removeAllRanges: () => {},
  }),
  innerWidth: 1024,
  innerHeight: 768,
}

global.document = {
  readyState: 'complete',
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  documentElement: { append: () => {} },
  body: { appendChild: () => {}, removeChild: () => {} },
  createElement: (tag) => ({
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    setAttribute: () => {},
    getAttribute: () => null,
    append: () => {},
    appendChild: () => {},
    replaceChildren: () => {},
    addEventListener: () => {},
  }),
}

global.chrome = {
  runtime: {
    sendMessage: () => Promise.resolve({}),
    onMessage: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
  },
  // Only enough to let service-worker.js's top-level listener registrations
  // run without throwing when it's imported directly in a test — none of
  // these are expected to actually fire in tests that don't simulate a real
  // context-menu click.
  contextMenus: {
    create: () => {},
    onClicked: { addListener: () => {} },
  },
  storage: {
    local: {
      // Real chrome.storage.local crosses an IPC boundary, so every get()
      // returns a structured-clone copy, never the live stored object — two
      // concurrent reads get two independent snapshots, and whichever set()
      // finishes last wins outright. Cloning here too (instead of handing
      // back shared references) is what makes the session read-modify-write
      // lock's tests meaningful — without it, "concurrent" mutations in a
      // test would invisibly share one object and never actually race.
      get(keys) {
        if (typeof keys === 'string') {
          return Promise.resolve({ [keys]: structuredClone(_store[keys]) })
        }
        const result = {}
        const ks = Array.isArray(keys) ? keys : Object.keys(keys)
        for (const k of ks) result[k] = structuredClone(_store[k])
        return Promise.resolve(result)
      },
      set(items) {
        Object.assign(_store, structuredClone(items))
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
