import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node', // Node 18+ has crypto.subtle built in
    globals: true,
    setupFiles: ['tests/setup.js'],
  },
})
