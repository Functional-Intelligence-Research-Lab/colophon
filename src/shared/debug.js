/**
 * Development-only tracing, off by default so a real user's DevTools
 * console isn't full of internal diagnostic output. Flip DEBUG to true
 * locally when investigating an issue.
 */
export const DEBUG = false;

export function debugLog(...args) {
  if (DEBUG) console.log(...args);
}
