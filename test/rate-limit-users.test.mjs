/**
 * The pure parts of scripts/rate-limit-users.mjs. The rest drives the stub and
 * the backend, which only a real run has.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  baselineProjectId,
  csvLine,
  parseUserCount,
  rateLimitUserEmail
} from '../scripts/rate-limit-users.mjs'

describe('rate-limit users', () => {
  test('each user has its own stable email, so re-runs replace rather than pile up', () => {
    assert.equal(rateLimitUserEmail(1), 'bng-perf-rate-limit-1@bng.example.com')
    assert.notEqual(rateLimitUserEmail(1), rateLimitUserEmail(2))
  })

  test('takes a whole number of users above 0, and nothing else', () => {
    assert.equal(parseUserCount('9'), 9)
    assert.equal(parseUserCount('0'), null)
    assert.equal(parseUserCount('2.5'), null)
    assert.equal(parseUserCount(undefined), null)
  })

  test('finds the project with a baseline, in either list shape', () => {
    const projects = [
      { id: 'empty', has_baseline: false },
      { id: 'with-baseline', has_baseline: true }
    ]
    assert.equal(baselineProjectId(projects), 'with-baseline')
    assert.equal(baselineProjectId({ projects }), 'with-baseline')
    assert.equal(
      baselineProjectId([{ id: 'old-shape', baseline: { habitats: [{}] } }]),
      'old-shape'
    )
    assert.equal(baselineProjectId([{ id: 'empty' }]), null)
  })

  test('writes one row per user, and refuses a value that would break the CSV', () => {
    assert.equal(csvLine('a.b.c', 'p-1'), 'a.b.c,p-1')
    assert.throws(() => csvLine('a,b', 'p-1'))
    assert.throws(() => csvLine('a', 'p 1'))
  })
})
