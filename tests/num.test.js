import { describe, it, expect } from 'vitest'
import { finiteNumber } from '../src/shared/num.js'

describe('finiteNumber', () => {
  it('passes real numbers through', () => {
    expect(finiteNumber(42)).toBe(42)
    expect(finiteNumber(-7)).toBe(-7)
    expect(finiteNumber(0.5)).toBe(0.5)
  })

  it('rejects anything a crafted file could use to inject markup', () => {
    expect(finiteNumber('<img src=x onerror=alert(1)>')).toBe(0)
    expect(finiteNumber('42')).toBe(0)
    expect(finiteNumber({ toString: () => '<b>x</b>' })).toBe(0)
    expect(finiteNumber(['<b>x</b>'])).toBe(0)
  })

  it('uses the fallback for missing or non-finite values', () => {
    expect(finiteNumber(undefined)).toBe(0)
    expect(finiteNumber(null, null)).toBe(null)
    expect(finiteNumber(undefined, null)).toBe(null)
    expect(finiteNumber(NaN, null)).toBe(null)
    expect(finiteNumber(Infinity)).toBe(0)
  })
})
