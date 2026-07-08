import { describe, it, expect } from 'vitest'
import { analyzeText } from '../src/lib/heuristics.js'

describe('analyzeText — filler_words', () => {
  it('does not flag words that merely contain a filler word as a substring', () => {
    const text = 'Every citizen deserves justice under the law, and the government must adjust its policies to reflect this basic principle of fairness for all people in the nation regardless of their background or circumstances in life.'
    const tips = analyzeText(text)
    expect(tips.some(t => t.rule === 'filler_words')).toBe(false)
  })

  it('still flags real filler words on word boundaries', () => {
    const text = 'This is basically just a very simple idea that is really quite easy to understand honestly, and it should probably work for most people who read it carefully.'
    const tips = analyzeText(text)
    const hit = tips.find(t => t.rule === 'filler_words')
    expect(hit).toBeTruthy()
    expect(hit.text).toContain('very')
    expect(hit.text).toContain('just')
  })
})
