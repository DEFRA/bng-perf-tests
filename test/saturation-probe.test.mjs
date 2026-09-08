/**
 * The half of the saturation probe that decides what a run MEANS.
 *
 * The network half needs a live backend, an uploader and a virus scanner, so it
 * is not covered here. What is covered is everything that turns a pile of HTTP
 * responses into the number someone will paste into a ticket — and each of
 * these is a way that number could be quietly wrong:
 *
 *   - a 503 counted as a failure rather than as the load shed it is;
 *   - a "clear to 20" claimed over a ladder that was refused at 8;
 *   - a knee reported off a burst the client never actually managed to fire.
 *
 * node:test and node:assert only, matching the rest of the suite.
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import {
  OUTCOME,
  classifyResponse,
  findKnee,
  formatTable,
  maxOverlap,
  parseLadder,
  percentile,
  summariseStep,
  verdictLines
} from '../scripts/saturation-probe.mjs'

/** A result row, with only the fields the function under test reads. */
const result = (outcome, { durationMs = 100, startedAt = 0, endedAt = 100, retryAfterSeconds = null } = {}) => ({
  outcome,
  durationMs,
  startedAt,
  endedAt,
  retryAfterSeconds
})

describe('parseLadder', () => {
  test('reads a comma-separated ladder', () => {
    assert.deepEqual(parseLadder('1,2,4,8'), [1, 2, 4, 8])
  })

  test('sorts and de-duplicates, so a ladder always climbs', () => {
    // A staircase that does not climb cannot find a knee: a rung out of order
    // would be charged the previous rung's backlog and read as a false refusal.
    assert.deepEqual(parseLadder('8,2,4,2,1'), [1, 2, 4, 8])
  })

  test('tolerates whitespace and trailing separators', () => {
    assert.deepEqual(parseLadder(' 1 , 2 , '), [1, 2])
  })

  test('refuses a step that is not a positive integer', () => {
    // Loudly, rather than dropping it: a silently missing rung leaves a hole in
    // the ladder that nothing in the report would explain.
    assert.throws(() => parseLadder('1,two,4'), /bad ladder step "two"/)
    assert.throws(() => parseLadder('1,0'), /bad ladder step "0"/)
    assert.throws(() => parseLadder('1,2.5'), /bad ladder step "2.5"/)
    assert.throws(() => parseLadder('1,-4'), /bad ladder step "-4"/)
  })

  test('refuses an empty ladder', () => {
    assert.throws(() => parseLadder(''), /ladder is empty/)
    assert.throws(() => parseLadder(undefined), /ladder is empty/)
  })
})

describe('classifyResponse', () => {
  const busyBody = { valid: false, errors: [{ code: 'VALIDATION_BUSY' }] }

  test('a 503 carrying VALIDATION_BUSY is the load shed we are looking for', () => {
    assert.equal(
      classifyResponse({ status: 503, body: busyBody }),
      OUTCOME.busy
    )
  })

  test('a 503 without it came from Hapi, before the route ran', () => {
    // The RSS load limit answers with a plain Boom body. It means something
    // different from the validator refusing, so it is counted apart.
    assert.equal(
      classifyResponse({
        status: 503,
        body: { statusCode: 503, error: 'Service Unavailable' }
      }),
      OUTCOME.overloaded
    )
    assert.equal(classifyResponse({ status: 503, body: null }), OUTCOME.overloaded)
  })

  test('a 200 is the service coping, even when the file is invalid', () => {
    // `valid: false` means the file was read and judged. That is the service
    // working, and counting it as a failure would hide the real knee.
    assert.equal(
      classifyResponse({
        status: 200,
        body: { valid: false, errors: [{ code: 'OVERLAPPING_PARCELS' }] }
      }),
      OUTCOME.ok
    )
  })

  test('a 409 is the probe\'s own fault, not a service limit', () => {
    assert.equal(classifyResponse({ status: 409, body: {} }), OUTCOME.conflict)
  })

  test('anything else is an error', () => {
    assert.equal(classifyResponse({ status: 500, body: {} }), OUTCOME.error)
    assert.equal(classifyResponse({ status: 401, body: {} }), OUTCOME.error)
    assert.equal(classifyResponse({ status: 0, body: null }), OUTCOME.error)
  })
})

describe('percentile', () => {
  test('nearest-rank, so it only ever reports a latency that happened', () => {
    const sorted = [10, 20, 30, 40]
    assert.equal(percentile(sorted, 50), 20)
    assert.equal(percentile(sorted, 95), 40)
    assert.equal(percentile(sorted, 100), 40)
  })

  test('a single sample is its own percentile', () => {
    assert.equal(percentile([7], 95), 7)
  })

  test('an empty sample has none', () => {
    assert.equal(percentile([], 50), null)
  })
})

describe('maxOverlap', () => {
  test('counts requests that were genuinely in flight together', () => {
    assert.equal(
      maxOverlap([
        { startedAt: 0, endedAt: 100 },
        { startedAt: 10, endedAt: 90 },
        { startedAt: 20, endedAt: 30 }
      ]),
      3
    )
  })

  test('requests that merely touch never overlapped', () => {
    // Serialised requests are the failure this check exists to catch, so an end
    // and a start at the same instant must not read as concurrency.
    assert.equal(
      maxOverlap([
        { startedAt: 0, endedAt: 100 },
        { startedAt: 100, endedAt: 200 },
        { startedAt: 200, endedAt: 300 }
      ]),
      1
    )
  })

  test('reports the peak, not the total', () => {
    assert.equal(
      maxOverlap([
        { startedAt: 0, endedAt: 10 },
        { startedAt: 5, endedAt: 15 },
        { startedAt: 100, endedAt: 110 }
      ]),
      2
    )
  })

  test('nothing in flight is zero', () => {
    assert.equal(maxOverlap([]), 0)
  })
})

describe('summariseStep', () => {
  test('counts each outcome and derives the refusal rate', () => {
    const step = summariseStep({
      users: 4,
      results: [
        result(OUTCOME.ok),
        result(OUTCOME.ok),
        result(OUTCOME.busy, { retryAfterSeconds: 5 }),
        result(OUTCOME.overloaded)
      ]
    })
    assert.equal(step.sent, 4)
    assert.equal(step[OUTCOME.ok], 2)
    assert.equal(step[OUTCOME.busy], 1)
    assert.equal(step[OUTCOME.overloaded], 1)
    // Both kinds of 503 are refusals: the user did not get their file checked
    // either way, which is what the knee is about.
    assert.equal(step.refused, 2)
    assert.equal(step.refusedRate, 0.5)
  })

  test('carries the longest Retry-After the service asked for', () => {
    // It is what the settle between rungs is derived from, so the slowest
    // instruction has to win rather than the last one seen.
    const step = summariseStep({
      users: 2,
      results: [
        result(OUTCOME.busy, { retryAfterSeconds: 5 }),
        result(OUTCOME.busy, { retryAfterSeconds: 12 })
      ]
    })
    assert.equal(step.retryAfterSeconds, 12)
  })

  test('has no Retry-After when nothing was refused', () => {
    const step = summariseStep({ users: 1, results: [result(OUTCOME.ok)] })
    assert.equal(step.retryAfterSeconds, null)
    assert.equal(step.refusedRate, 0)
  })

  test('reports latency percentiles and the measured overlap', () => {
    const step = summariseStep({
      users: 3,
      results: [
        result(OUTCOME.ok, { durationMs: 30, startedAt: 0, endedAt: 30 }),
        result(OUTCOME.ok, { durationMs: 10, startedAt: 0, endedAt: 10 }),
        result(OUTCOME.ok, { durationMs: 20, startedAt: 0, endedAt: 20 })
      ]
    })
    assert.equal(step.p50Ms, 20)
    assert.equal(step.maxMs, 30)
    assert.equal(step.maxOverlap, 3)
  })

  test('a step whose requests serialised says so', () => {
    // Asked for 3 at once, got 1 at a time. Without this the rung would be read
    // as "the service coped with 3" when it was never offered 3.
    const step = summariseStep({
      users: 3,
      results: [
        result(OUTCOME.ok, { startedAt: 0, endedAt: 10 }),
        result(OUTCOME.ok, { startedAt: 10, endedAt: 20 }),
        result(OUTCOME.ok, { startedAt: 20, endedAt: 30 })
      ]
    })
    assert.equal(step.maxOverlap, 1)
    assert.ok(step.maxOverlap < step.users)
  })
})

describe('findKnee', () => {
  const step = (users, { refused = 0, sent = users } = {}) => ({
    users,
    sent,
    refused,
    refusedRate: sent ? refused / sent : 0
  })

  test('finds the last clean rung and the first refused one', () => {
    const knee = findKnee(
      [step(1), step(2), step(4), step(8, { refused: 1 }), step(16, { refused: 12 })],
      { stopRate: 0.5 }
    )
    assert.equal(knee.clearTo, 4)
    assert.equal(knee.firstRefusedAt, 8)
    assert.equal(knee.saturatedAt, 16)
  })

  test('a ladder that never saturates has no knee to report', () => {
    const knee = findKnee([step(1), step(2), step(4)], { stopRate: 0.5 })
    assert.equal(knee.clearTo, 4)
    assert.equal(knee.firstRefusedAt, null)
    assert.equal(knee.saturatedAt, null)
  })

  test('refused at the very first rung means no capacity was demonstrated', () => {
    // Not "clear to 0" dressed up as a measurement: there is no clean rung
    // below the first refusal, so the ladder proved nothing about capacity.
    const knee = findKnee([step(1, { refused: 1 }), step(2, { refused: 2 })], {
      stopRate: 0.5
    })
    assert.equal(knee.clearTo, null)
    assert.equal(knee.firstRefusedAt, 1)
  })

  test('never claims capacity above a rung that was already refused', () => {
    // The dangerous case: a refusal at 4, then a clean 8 because the burst
    // happened to land while the pool had drained. "clear to 8" would be a lie
    // a capacity plan could be built on.
    const knee = findKnee(
      [step(1), step(2), step(4, { refused: 2 }), step(8)],
      { stopRate: 0.5 }
    )
    assert.equal(knee.clearTo, 2)
    assert.equal(knee.firstRefusedAt, 4)
  })

  test('saturation is the rate crossing the threshold, not the first refusal', () => {
    const knee = findKnee(
      [step(10, { refused: 1 }), step(20, { refused: 10 }), step(40, { refused: 40 })],
      { stopRate: 0.5 }
    )
    assert.equal(knee.firstRefusedAt, 10)
    assert.equal(knee.saturatedAt, 20)
  })
})

describe('verdictLines', () => {
  const summarised = (users, refused) =>
    summariseStep({
      users,
      results: [
        ...Array.from({ length: users - refused }, () => result(OUTCOME.ok)),
        ...Array.from({ length: refused }, () => result(OUTCOME.busy))
      ]
    })

  test('names the bracket the knee lies in', () => {
    const steps = [summarised(4, 0), summarised(8, 3)]
    const knee = findKnee(steps, { stopRate: 0.5 })
    const text = verdictLines({ knee, steps, ladder: [4, 8], stopRate: 0.5 }).join('\n')
    assert.match(text, /Clear to 4 concurrent; first refusal at 8/)
    assert.match(text, /between 4 and 8/)
  })

  test('says the ladder was too short rather than inventing a knee', () => {
    const steps = [summarised(4, 0), summarised(8, 0)]
    const knee = findKnee(steps, { stopRate: 0.5 })
    const text = verdictLines({ knee, steps, ladder: [4, 8], stopRate: 0.5 }).join('\n')
    assert.match(text, /did not saturate/)
    assert.match(text, /Raise --ladder past 8/)
  })

  test('calls out a service that was already shedding before the run', () => {
    const steps = [summarised(1, 1)]
    const knee = findKnee(steps, { stopRate: 0.5 })
    const text = verdictLines({ knee, steps, ladder: [1, 2], stopRate: 0.5 }).join('\n')
    assert.match(text, /Nothing here measures a knee/)
  })
})

describe('formatTable', () => {
  test('every rung gets a row, under aligned headings', () => {
    const steps = [
      summariseStep({ users: 1, results: [result(OUTCOME.ok)] }),
      summariseStep({
        users: 2,
        results: [result(OUTCOME.ok), result(OUTCOME.busy)]
      })
    ]
    const lines = formatTable(steps).split('\n')
    // Heading, rule, one row per rung.
    assert.equal(lines.length, 4)
    assert.match(lines[0], /users\s+sent\s+200\s+503 busy/)
    assert.match(lines[3], /50%/)
    const widths = new Set(lines.map((line) => line.length))
    assert.equal(widths.size, 1, 'every row is the same width')
  })
})
