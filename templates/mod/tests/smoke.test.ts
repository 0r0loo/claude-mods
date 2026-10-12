import { expect, test } from 'claude-code/testing'

import { register } from '../hooks/register'

test('모듈을 불러올 수 있다', () => {
  expect(typeof register).toBe('function')
})
