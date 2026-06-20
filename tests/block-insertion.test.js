/**
 * block-insertion.test.js — single-frame block insertion classifier
 * (src/content/block-insertion.js)
 */

import { describe, it, expect } from 'vitest'
import { classifyInsertion, BLOCK_MIN_CHARS } from '../src/content/block-insertion.js'

describe('classifyInsertion', () => {
  it('treats small insertions as typing, not a block', () => {
    const r = classifyInsertion({ inputType: 'insertText', insertedLength: 3 })
    expect(r.isBlock).toBe(false)
    expect(r.origin).toBe('typing')
  })

  it('flags a large clipboard paste as a block of origin paste', () => {
    const r = classifyInsertion({ inputType: 'insertFromPaste', insertedLength: 200 })
    expect(r.isBlock).toBe(true)
    expect(r.origin).toBe('paste')
  })

  it('flags a drop the same as a paste', () => {
    const r = classifyInsertion({ inputType: 'insertFromDrop', insertedLength: 50 })
    expect(r.origin).toBe('paste')
  })

  it('attributes a large AI insert to ai', () => {
    const r = classifyInsertion({ inputType: 'insertText', insertedLength: 80, isAiInsert: true })
    expect(r.isBlock).toBe(true)
    expect(r.origin).toBe('ai')
  })

  it('flags a large non-paste, non-AI insert as unknown (the interesting case)', () => {
    const r = classifyInsertion({ inputType: 'insertText', insertedLength: 120 })
    expect(r.isBlock).toBe(true)
    expect(r.origin).toBe('unknown')
  })

  it('uses BLOCK_MIN_CHARS as the threshold (boundary)', () => {
    expect(classifyInsertion({ insertedLength: BLOCK_MIN_CHARS - 1 }).isBlock).toBe(false)
    expect(classifyInsertion({ insertedLength: BLOCK_MIN_CHARS }).isBlock).toBe(true)
  })

  it('is safe with no arguments', () => {
    const r = classifyInsertion()
    expect(r.isBlock).toBe(false)
  })
})
