import { expect, test } from 'claude-code/testing'

import { elapsed, meter, untilReset } from '../hooks/register'

test('meter fills in proportion to the percent', () => {
  expect(meter(0, 10)).toBe('░░░░░░░░░░')
  expect(meter(50, 10)).toBe('█████░░░░░')
  expect(meter(120, 4)).toBe('████')
})

test('untilReset and elapsed read as short units', () => {
  const now = Date.parse('2026-10-12T00:00:00Z')
  expect(untilReset('2026-10-12T02:30:00Z', now)).toBe('2h30m')
  expect(untilReset('2026-10-15T04:00:00Z', now)).toBe('3d4h')
  expect(untilReset('2026-10-12T03:00:00Z', now)).toBe('3h')
  expect(untilReset(undefined, now)).toBe('')
  expect(elapsed(75 * 60000)).toBe('1h15m')
  expect(elapsed(5 * 60000)).toBe('5m')
})

import { cacheHitPercent, shortModel } from '../hooks/register'

test('cache hit rate and model name', () => {
  expect(cacheHitPercent({ model: 'm', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 })).toBe(90)
  expect(cacheHitPercent(undefined)).toBe(null)
  expect(shortModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5')
})
