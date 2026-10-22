/**
 * popup-activity-item.test.js
 *
 * Regression coverage for the popup.js XSS landmine: ActivityItem()
 * interpolated item.title/item.meta into innerHTML-bound markup with no
 * escaping. For every real event type today this is always a hardcoded
 * literal (safe by construction), except the 'info' branch in
 * eventToActivity(), which passes raw event.title/event.meta straight
 * through — currently dead code (no producer emits a type: 'info' event),
 * but a real stored-XSS sink in this privileged extension page the moment
 * that changes.
 */

import { describe, it, expect } from 'vitest'
import { ActivityItem, eventToActivity } from '../src/popup/popup.js'

describe('ActivityItem — HTML escaping', () => {
  it('escapes a malicious title/meta instead of interpolating it raw', () => {
    const item = eventToActivity({
      type: 'info',
      title: '<img src=x onerror=alert(1)>',
      meta: ['<script>alert(2)</script>'],
    })
    const html = ActivityItem(item)
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>alert(2)</script>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;')
  })

  it('still renders ordinary event titles/meta normally', () => {
    const item = eventToActivity({ type: 'paste', timestamp: new Date().toISOString() })
    const html = ActivityItem(item)
    expect(html).toContain('You added a source')
  })
})
