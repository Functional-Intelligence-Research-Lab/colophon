import { describe, it, expect } from 'vitest'
import {
  VALID_SOURCE_TOOLS,
  SOURCE_TOOL_LABELS,
  SOURCE_TOOLS,
  getSourceToolLabel,
  formatSelfReportedLabel,
} from '../src/shared/source-tools.js'

describe('source-tools specification and labeling', () => {
  it('defines a small fixed set of common AI tools plus other and not AI', () => {
    expect(VALID_SOURCE_TOOLS).toEqual([
      'chatgpt',
      'claude',
      'copilot',
      'gemini',
      'perplexity',
      'deepseek',
      'other_ai',
      'not_ai',
    ])
  })

  it('maps every tool key to a human-readable label', () => {
    for (const key of VALID_SOURCE_TOOLS) {
      expect(SOURCE_TOOL_LABELS[key]).toBeDefined()
      expect(getSourceToolLabel(key)).toBe(SOURCE_TOOL_LABELS[key])
    }
  })

  it('provides SOURCE_TOOLS array matching VALID_SOURCE_TOOLS in order', () => {
    expect(SOURCE_TOOLS.map(t => t.id)).toEqual(VALID_SOURCE_TOOLS)
  })

  it('honestly formats the label as self-reported, never implied to be detected', () => {
    const formatted = formatSelfReportedLabel('claude')
    expect(formatted).toBe('Self-reported source: Claude')
    expect(formatted.toLowerCase()).not.toContain('detected')
    expect(formatted.toLowerCase()).not.toContain('flagged')
    expect(formatted.toLowerCase()).toContain('self-reported')
  })

  it('returns empty string when toolKey is falsy', () => {
    expect(formatSelfReportedLabel(null)).toBe('')
    expect(formatSelfReportedLabel(undefined)).toBe('')
    expect(formatSelfReportedLabel('')).toBe('')
  })
})
