import { describe, it, expect } from 'vitest'
import { formatDocTitle } from '../src/shared/doc-title.js'

describe('formatDocTitle', () => {
  it('strips the Google Docs tab-title suffix', () => {
    expect(formatDocTitle('My Essay - Google Docs')).toBe('My Essay')
  })

  it('falls back to a plain label for an empty title', () => {
    expect(formatDocTitle('')).toBe('Untitled document')
  })

  it('falls back to a plain label when nothing is left after stripping', () => {
    expect(formatDocTitle(' - Google Docs')).toBe('Untitled document')
  })

  it('does not fabricate anything for a real title that happens to contain the suffix text', () => {
    expect(formatDocTitle('Google Docs Tips - Google Docs')).toBe('Google Docs Tips')
  })
})
