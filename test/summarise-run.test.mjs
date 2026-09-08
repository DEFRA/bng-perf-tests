/**
 * The summary is the part of a run that gets pasted into a ticket, so a group
 * that silently reports nothing is worse than one that errors — the reader has
 * no way to tell "we measured this and it was fine" from "we never measured
 * it".
 *
 * These drive the real script over a synthetic results CSV carrying every
 * label shape the plan emits, and assert that each section appears and says
 * the right thing. The label shapes are the contract between
 * scripts/gen-scenario.mjs and scripts/summarise-run.mjs; if a sampler is
 * renamed in one and not the other, this is what notices.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, before } from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const HEADERS = ['timeStamp', 'elapsed', 'label', 'responseCode', 'success', 'threadName']

/**
 * Build a results CSV covering every group.
 *
 * Timestamps advance with each sample so the phase windows the summary derives
 * (and the probe attribution that depends on them) are in run order, the same
 * as a real file.
 */
function buildResults() {
  const rows = []
  let now = 1_700_000_000_000
  const add = (label, elapsed, code, thread) => {
    rows.push([now, elapsed, label, code, code === '409' ? 'false' : 'true', thread])
    now += elapsed + 20
  }

  for (const [size, ms, n] of [
    ['normal', 400, 20],
    ['busy', 900, 8],
    ['large', 4200, 3],
    ['xlarge', 9000, 2]
  ]) {
    for (let i = 0; i < n; i++) {
      add(`validation cost vs file size: ${size} (1 user)`, ms, '200', 'Size ramp 1-1')
    }
  }

  // Journey legs, three per iteration on one thread, so the end-to-end
  // reconstruction has triples to close.
  for (const [size, base, steps] of [
    ['normal', 900, [1, 2, 10]],
    ['large', 5200, [1, 3]]
  ]) {
    for (const users of steps) {
      for (let u = 1; u <= users; u++) {
        const thread = `Upload journey ${size} @ ${users} user(s) 1-${u}`
        add(`journey (${size}) @ ${users} user(s): initiate`, 60, '200', thread)
        add(`journey (${size}) @ ${users} user(s): send file to uploader`, 200, '302', thread)
        add(`journey (${size}) @ ${users} user(s): validate incl virus scan`, base + users * 40, '200', thread)
      }
    }
  }

  for (const users of [1, 5, 20]) {
    for (let i = 0; i < 5; i++) {
      add(`validation cost vs concurrency: ${users} user(s) on one large upload`, 3800 + users * 200, '200', 'Validation vs concurrency 1-1')
    }
  }
  for (const users of [1, 5]) {
    for (let i = 0; i < 4; i++) {
      add(`post-intervention validate (normal) @ ${users} user(s)`, 1500, '200', 'PI 1-1')
    }
  }
  for (const users of [1, 5]) {
    for (let i = 0; i < 10; i++) {
      add(`habitat edit distinct projects (normal) @ ${users} user(s)`, 120, '200', 'Edit 1-1')
    }
  }
  // Contention: one in four conflicts at 2 users, half at 5.
  for (const [users, every] of [[2, 4], [5, 2]]) {
    for (let i = 0; i < 20; i++) {
      const conflict = i % every === 0
      add(
        `habitat edit same project @ ${users} user(s)`,
        conflict ? 5000 : 180,
        conflict ? '409' : '200',
        'Contention 1-1'
      )
    }
  }
  for (const [size, ms, n] of [
    ['normal', 90, 10],
    ['busy', 260, 6],
    ['large', 1400, 4],
    ['xlarge', 3600, 3]
  ]) {
    for (let i = 0; i < n; i++) {
      add(`fetch ${size} project (GET /projects/{id})`, ms, '200', 'Fetch 1-1')
    }
  }
  for (let i = 0; i < 20; i++) {
    add('mixed: list my projects (GET /projects)', 150, '200', 'Mixed 1-1')
  }

  // The saturation ladder: a clean climb, then refusals. `normal` stays clear
  // throughout; `large` refuses from a burst of 4 up, so the two knee shapes the
  // report has to distinguish are both present.
  for (const [size, base, rungs] of [
    ['normal', 800, [[8, 0], [16, 0], [24, 0]]],
    ['large', 6000, [[2, 0], [4, 2], [6, 5], [8, 7]]]
  ]) {
    for (const [burst, refused] of rungs) {
      for (let i = 0; i < burst; i++) {
        const busy = i < refused
        add(
          `saturation: burst of ${burst} on one ${size} upload`,
          // A refusal returns fast; a served request does not. The summary must
          // not average the two together.
          busy ? 900 : base + burst * 30,
          busy ? '503' : '200',
          `Saturation (${size}) @ burst of ${burst} 1-${i + 1}`
        )
      }
    }
  }

  // The probe spans the whole run, so every phase gets a "during" row.
  const start = rows[0][0]
  for (let ts = start; ts < now; ts += 1500) {
    rows.push([ts, 200, 'probe: project list under load (GET /projects)', '200', 'true', 'Probe 1-1'])
  }
  return [HEADERS, ...rows].map((r) => r.join(',')).join('\n') + '\n'
}

let output = ''

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'bng-perf-summary-'))
  const csv = join(dir, 'results.csv')
  writeFileSync(csv, buildResults())
  output = execFileSync(
    process.execPath,
    [join(ROOT, 'scripts', 'summarise-run.mjs'), csv],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        SIZE_RAMP_EXPECTED: 'normal:20,busy:8,large:3,xlarge:2',
        SIZE_RAMP_WINDOW_SECONDS: '160'
      }
    }
  )
})

describe('every group reports', () => {
  const sections = [
    ['upload journey, end to end', 'N people upload N files at once'],
    ['size ramp', 'How long does one upload take, by file size?'],
    ['journey legs', 'where does that journey time go'],
    ['validation vs concurrency', 'What does validate alone cost as concurrency climbs'],
    ['post-intervention', 'What does a post-intervention upload cost'],
    ['habitat edit', 'What does editing one habitat cost'],
    ['project fetch', 'What does fetching a whole project cost'],
    ['mixed workload', 'What does the mixed workload look like'],
    ['edit contention', 'edit the SAME project at once'],
    ['saturation', 'start REFUSING uploads'],
    ['probe', 'What an ordinary user experienced at the same time']
  ]
  for (const [name, heading] of sections) {
    test(`${name} has a section`, () => {
      assert.ok(output.includes(heading), `missing section: ${heading}`)
    })
  }
})

describe('the journey ladder', () => {
  test('reconstructs an end-to-end time per step, not per leg', () => {
    assert.match(output, /end to end \(normal\) @ 1 user\(s\)/)
    assert.match(output, /end to end \(normal\) @ 10 user\(s\)/)
    assert.match(output, /end to end \(large\) @ 3 user\(s\)/)
  })

  test('keeps the sizes apart rather than averaging them together', () => {
    // A 4 MB upload and a 143 KB upload at the same concurrency are the two
    // questions the per-size ladder exists to separate.
    const normal = /end to end \(normal\) @ 1 user\(s\)\s+(\d+)/.exec(output)
    const large = /end to end \(large\) @ 1 user\(s\)\s+(\d+)/.exec(output)
    assert.ok(normal && large, 'both sizes should have their own row')
  })

  test('orders the ladder by size and then by concurrency', () => {
    const order = [...output.matchAll(/end to end \((\w+)\) @ (\d+) user/g)].map(
      (m) => `${m[1]}:${m[2]}`
    )
    assert.deepEqual(order, [
      'normal:1',
      'normal:2',
      'normal:10',
      'large:1',
      'large:3'
    ])
  })
})

/**
 * Just the saturation table and verdict.
 *
 * Bounded by the NEXT section's underline rather than by a known heading: the
 * ramp-coverage table further down also has a row starting `large`, with three
 * columns instead of eight, and letting it leak in here makes this test assert
 * against the wrong numbers.
 */
function saturationSection(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.includes('start REFUSING uploads?'))
  if (start === -1) {
    return ''
  }
  // start + 1 is this section's own underline, so look past it for the next.
  let end = lines.length
  for (let i = start + 2; i < lines.length; i++) {
    if (/^─+$/.test(lines[i])) {
      end = i - 1
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

describe('the saturation ladder', () => {
  test('counts 503s as a refusal rate rather than as failures', () => {
    // The same call the contention section makes for 409s. A 503 here means the
    // validator shed the request on purpose; counting it as a failure would
    // report correct load-shedding as a broken service.
    assert.match(output, /Where does the service start REFUSING uploads\?/)
    assert.match(output, /503 busy/)
    assert.match(output, /refused/)
  })

  test('names the knee per size, and only where there is one', () => {
    // large refuses from a burst of 4, so its clear-to is the rung below.
    assert.match(output, /large: clear to a burst of 2; first refusal at 4\./)
    // normal never refused on this ladder, and must not be given a made-up knee.
    assert.match(output, /normal: nothing refused on this ladder/)
  })

  test('latency covers the SERVED requests only', () => {
    // The refusals in the fixture return in 900ms and the served large requests
    // take 6s+. If refusals were folded in, the worst-case column for the most
    // saturated rung would collapse toward the refusal time and the rung would
    // read as FASTER than the clean one below it.
    // Scoped to the saturation section: `large` also names a row in the size
    // ramp and journey tables, and those have different columns entirely.
    const rows = saturationSection(output)
      .split('\n')
      .filter((line) => /^\s+large\s+\d+/.test(line))
      .map((line) => line.trim().split(/\s+/))
    assert.ok(rows.length >= 2, 'expected several large rungs in the table')
    for (const row of rows) {
      // size, burst, sent, served, 503 busy, refused%, p95, worst
      const [, , sent, served, busy] = row
      assert.equal(Number(sent), Number(served) + Number(busy))
    }
    // Every served large request took at least 6s, so no rung may report a
    // sub-second p95 — which is what averaging refusals in would produce.
    for (const row of rows) {
      const p95 = row[6]
      assert.match(p95, /s$/, `p95 ${p95} looks like a refusal, not a served request`)
    }
  })

  test('says which refusal reason to go and look up', () => {
    // The 503 body deliberately does not carry it, so a report that did not
    // point at the metric would leave the actionable half of the finding out.
    assert.match(output, /GeoPackageValidationBusy/)
    assert.match(output, /no_capacity \| queue_full \| queue_wait \| memory_budget/)
  })
})

describe('rungs that were never measured', () => {
  /**
   * The most dangerous mistake this report could make.
   *
   * A saturation ladder is truncated on purpose, so rungs are routinely absent
   * from the results — and in a table of what WAS measured, an absent rung and
   * a rung that refused nothing look identical. Reading one as the other
   * publishes capacity that was never tested, which is precisely the number
   * someone would size a service on.
   */
  let partial = ''

  before(() => {
    const rows = [HEADERS]
    let now = 1_700_000_000_000
    // Only the three `normal` rungs produced anything.
    for (const burst of [8, 16, 24]) {
      for (let i = 0; i < burst; i++) {
        rows.push([
          now,
          800,
          `saturation: burst of ${burst} on one normal upload`,
          '200',
          'true',
          `Saturation (normal) @ burst of ${burst} 1-${i + 1}`
        ])
        now += 820
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'bng-perf-unmeasured-'))
    const csv = join(dir, 'results.csv')
    writeFileSync(csv, rows.map((r) => r.join(',')).join('\n') + '\n')
    partial = execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'summarise-run.mjs'), csv],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PERF_PROFILE: 'saturate' } }
    )
  })

  test('a rung the cutoff never reached is named, not silently dropped', () => {
    assert.match(partial, /NOT MEASURED — past the 300s cutoff, never attempted/)
    assert.match(partial, /xlarge @ burst of 4/)
  })

  test('a rung that ran but produced nothing is called out as a PROBLEM', () => {
    // Distinct from the cutoff case on purpose: this one means staging failed
    // or the window cut the burst off, and it would otherwise be invisible.
    assert.match(partial, /scheduled but produced NO samples\. This is a/)
    assert.match(partial, /large @ burst of 2/)
  })

  test('a rung that DID report is not listed as unmeasured', () => {
    const notes = partial.slice(partial.indexOf('NOT MEASURED'))
    assert.doesNotMatch(notes, /normal @ burst of (8|16|24)/)
  })

  test('says nothing at all when no profile is named', () => {
    // Someone summarising a JTL by hand has no ladder to compare against, and
    // guessing at one would invent rungs the run never listed.
    const dir = mkdtempSync(join(tmpdir(), 'bng-perf-noprofile-'))
    const csv = join(dir, 'results.csv')
    writeFileSync(
      csv,
      [HEADERS, [1_700_000_000_000, 800, 'saturation: burst of 8 on one normal upload', '200', 'true', 't1-1']]
        .map((r) => r.join(','))
        .join('\n') + '\n'
    )
    const env = { ...process.env }
    delete env.PERF_PROFILE
    const out = execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'summarise-run.mjs'), csv],
      { cwd: ROOT, encoding: 'utf8', env }
    )
    assert.doesNotMatch(out, /NOT MEASURED/)
  })
})

describe('edit contention', () => {
  test('counts 409s as a rate rather than as failures', () => {
    const rows = [...output.matchAll(/@ (\d+) user\(s\)\s+20\s+(\d+)%/g)]
    const byUsers = Object.fromEntries(rows.map((m) => [m[1], Number(m[2])]))
    assert.equal(byUsers['2'], 25, 'one in four conflicted at 2 users')
    assert.equal(byUsers['5'], 50, 'one in two conflicted at 5 users')
  })

  test('reports the latency of accepted edits only', () => {
    // The 5s lock-timeout requests must not be averaged into the wait an
    // accepted edit actually experienced.
    const row = /@ 2 user\(s\)\s+20\s+25%\s+15\s+(\d+)ms/.exec(output)
    assert.ok(row, 'expected an accepted-only latency column')
    assert.equal(Number(row[1]), 180)
  })
})

describe('the probe timeline', () => {
  test('reads chronologically rather than by ladder', () => {
    // It is a timeline, not a staircase: ordering it by size and concurrency
    // interleaves phases that ran either side of each other.
    const sizeRamp = output.indexOf('during size ramp')
    const journey = output.indexOf('during upload journey (normal) @ 1 user(s)')
    const mixed = output.indexOf('during mixed workload')
    assert.ok(sizeRamp > 0 && journey > sizeRamp, 'size ramp ran before the journey')
    assert.ok(mixed > journey, 'the mixed workload ran last')
  })

  test('collapses a journey step to one row rather than one per leg', () => {
    const rows = output.match(/during upload journey \(normal\) @ 1 user\(s\)/g)
    assert.equal(rows.length, 1)
  })
})
