/**
 * The schedule arithmetic, and the promise that the committed plan matches the
 * config it is generated from.
 *
 * A perf suite fails quietly: a step scheduled on top of another one does not
 * error, it just makes a concurrency figure stop meaning what its label says,
 * and nobody finds out until a number is pasted into a ticket. These are the
 * checks that would have caught that.
 *
 * node:test and node:assert only — no framework, because the container this
 * runs in is a JMeter image with Node in it, not a JS project.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, describe } from 'node:test'

import {
  LADDERS,
  PROFILES,
  SETUP_ALLOWANCE_SECONDS,
  SIZE_LABELS,
  WINDOW_BOUNDS,
  budgetCheck,
  generatedBlockStartSeconds,
  ladderSteps,
  phasesBeyondCutoff,
  phasesWithinCutoff,
  profilePhases,
  runSeconds,
  stepAllowanceSeconds,
  scheduleFrom,
  stepKey,
  windowSeconds
} from '../scenarios/ladders.config.mjs'

const ROOT = join(import.meta.dirname, '..')

describe('window derivation', () => {
  test('a step gets less wall clock the more users it has', () => {
    const ladder = LADDERS.find((l) => l.key === 'journey')
    const at = (users) =>
      windowSeconds({ ladder, size: 'normal', users })
    assert.ok(
      at(1) > at(2),
      'one user has to wait out each iteration in turn, so it needs the longest window'
    )
    assert.ok(at(2) >= at(5))
  })

  test('windows stay inside the clamp at both ends', () => {
    // Closed-loop ladders only. A burst ladder's window is not a sample budget
    // to be clamped — see the next test.
    for (const ladder of LADDERS.filter((l) => !l.burst)) {
      for (const step of ladderSteps(ladder)) {
        const window = windowSeconds(step)
        assert.ok(
          window >= WINDOW_BOUNDS.minStepSeconds,
          `${stepKey(step)} window ${window}s is below the floor`
        )
        assert.ok(
          window <= WINDOW_BOUNDS.maxStepSeconds,
          `${stepKey(step)} window ${window}s is above the ceiling`
        )
      }
    }
  })

  test('a burst window is a safety net, so it EXCEEDS the burst it guards', () => {
    // The failure this prevents is the quiet one: a window shorter than the
    // burst cuts threads off mid-flight, and the rung then reports a refusal
    // rate computed from a partial sample as though it were a whole one. The
    // clamp above would have imposed exactly that on xlarge, which is why burst
    // ladders are excluded from it rather than squeezed into it.
    for (const ladder of LADDERS.filter((l) => l.burst)) {
      for (const step of ladderSteps(ladder)) {
        const window = windowSeconds(step)
        const burst = stepAllowanceSeconds(ladder, step.size) * ladder.bursts
        assert.ok(
          window > burst,
          `${stepKey(step)} window ${window}s does not clear its ${burst}s burst`
        )
      }
    }
  })

  test('a burst window does not shrink as the burst gets wider', () => {
    // Every closed-loop window divides by `users`, because N threads produce
    // samples N times faster. A burst is ONE simultaneous round however wide it
    // is, so the same division would give the widest rungs — the ones most
    // likely to saturate — the least time to finish.
    const ladder = LADDERS.find((l) => l.burst)
    const narrow = windowSeconds({ ladder, size: 'large', users: 2 })
    const wide = windowSeconds({ ladder, size: 'large', users: 12 })
    assert.equal(narrow, wide)
  })

  test('a bigger file gets a longer window at the same concurrency', () => {
    const ladder = LADDERS.find((l) => l.key === 'journey')
    assert.ok(
      windowSeconds({ ladder, size: 'large', users: 2 }) >
        windowSeconds({ ladder, size: 'normal', users: 2 })
    )
  })
})

describe('profiles', () => {
  test('every profile only names steps the plan has a thread group for', () => {
    const known = new Set(
      LADDERS.flatMap((ladder) => ladderSteps(ladder).map(stepKey))
    )
    for (const name of Object.keys(PROFILES)) {
      for (const phase of profilePhases(name)) {
        if (phase.key === 'fetchRamp' || phase.key === 'mixed') {
          continue
        }
        assert.ok(
          known.has(phase.key),
          `profile ${name} schedules ${phase.key}, which has no thread group`
        )
      }
    }
  })

  test('an unknown profile is rejected by name rather than running empty', () => {
    assert.throws(() => profilePhases('nope'), /unknown profile "nope"/)
  })

  test('the journey ladder is contiguous 1..10 at normal in standard', () => {
    const users = profilePhases('standard')
      .filter((p) => p.key.startsWith('journey_normal_'))
      .map((p) => p.users)
    assert.deepEqual(users, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  test('the profile list is exactly the two intended ones', () => {
    // The suite deliberately collapsed FIVE profiles into one: quick/standard/
    // deep/full/soak were different sampling depths of the SAME question, and
    // keeping five step lists meaningful cost more than the flexibility bought.
    // That decision still stands, and this assertion still guards it.
    //
    // `short` is admitted against it on purpose, because it is not another
    // depth of the same question. It asks the opposite one — where the service
    // starts REFUSING work — and answers it with a different pass rule (503 is
    // data, not failure), a different step shape (bursts, not closed loops) and
    // a cutoff instead of a budget. None of that could live as a knob on
    // `standard` without making `standard` mean two things.
    //
    // A THIRD entry should be a conscious decision, not an accident.
    assert.deepEqual(Object.keys(PROFILES), ['standard', 'short'])
  })
})

describe('schedule', () => {
  test('phases never overlap, and each starts a gap after the last ended', () => {
    for (const name of Object.keys(PROFILES)) {
      const scheduled = scheduleFrom(profilePhases(name), 100)
      for (let i = 1; i < scheduled.length; i++) {
        const previous = scheduled[i - 1]
        const current = scheduled[i]
        assert.equal(
          current.delay,
          previous.delay + previous.window + previous.gap,
          `${name}: ${current.key} does not start a gap after ${previous.key}`
        )
        assert.ok(
          current.delay > previous.delay + previous.window,
          `${name}: ${current.key} overlaps ${previous.key}`
        )
      }
    }
  })

  test('a ladder climbs — steps of one size are in ascending user order', () => {
    const bySize = new Map()
    for (const phase of profilePhases('standard')) {
      const match = /^(\w+?)_(\w+)_(\d+)$/.exec(phase.key)
      if (!match) {
        continue
      }
      const group = `${match[1]}_${match[2]}`
      const seen = bySize.get(group) ?? []
      seen.push(Number(match[3]))
      bySize.set(group, seen)
    }
    for (const [group, users] of bySize) {
      assert.deepEqual(
        users,
        [...users].sort((a, b) => a - b),
        `${group} does not climb`
      )
    }
  })
})

describe("the CDP portal's Profile field", () => {
  /**
   * A CDP perf-test task is configured through a single free-text field — the
   * portal's "Profile" — and cdp-self-service-ops sends it to the container as
   * PROFILE, not as TEST_SCENARIO.
   *
   * This suite read TEST_SCENARIO, which nothing on CDP sets: the base image
   * bakes it for its own sample plan and the Dockerfile clears it. So a task
   * started with Profile=short arrived with PROFILE=short and TEST_SCENARIO
   * empty, fell through to the default plan — which exists, so no warning fired
   * — and ran the full ~18-minute standard suite. It went green. The portal
   * showed the value that had been asked for. The report answered a different
   * question, and nothing anywhere said so.
   *
   * These pin the mapping, and they pin the announcement too, because the
   * failure mode here is not a run that breaks — it is a run that succeeds at
   * the wrong thing, and the only defence against that is a run that says what
   * it resolved.
   */
  const runFull = (env) =>
    spawnSync('sh', [join(ROOT, 'entrypoint.sh')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        JM_HOME: ROOT,
        ENVIRONMENT: 'local',
        PERF_DUMP_SCHEDULE: 'true',
        PERF_PROFILE: '',
        PROFILE: '',
        TEST_SCENARIO: '',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

  const run = (env) => runFull(env).stdout
  // The announcement is the point of half of these, and it is split across both
  // streams on purpose: a resolution is normal output, a fallback is a warning.
  const said = (env) => {
    const result = runFull(env)
    return `${result.stdout}\n${result.stderr}`
  }

  const phasesIn = (output) =>
    output.split('\n').filter((line) => line.startsWith('PHASE ')).map((l) => l.split(' ')[1])

  test('PROFILE selects the profile — the variable the portal actually sets', () => {
    const phases = phasesIn(run({ PROFILE: 'short' }))
    assert.ok(phases.length > 0, 'expected the saturation ladder to be scheduled')
    assert.ok(
      phases.every((key) => key.startsWith('saturate_')),
      `expected only saturation rungs, got ${phases.slice(0, 3).join(', ')}`
    )
  })

  test('PROFILE wins over TEST_SCENARIO', () => {
    // Both name a profile. The portal's variable is the one a real run carries,
    // so a TEST_SCENARIO inherited from the base image must not beat it.
    const phases = phasesIn(run({ PROFILE: 'short', TEST_SCENARIO: 'test' }))
    assert.ok(
      phases.every((key) => key.startsWith('saturate_')),
      'PROFILE=short must win over an inherited TEST_SCENARIO'
    )
  })

  test('an unknown PROFILE still runs, at the default, and says it did not match', () => {
    // Case matters and padding matters, because the comparison is exact — so
    // the run has to name what it got, or a capital letter costs 20 minutes and
    // a report that answers the wrong question.
    const output = said({ PROFILE: 'Short' })
    assert.ok(!phasesIn(output).some((key) => key.startsWith('saturate_')))
    assert.match(output, /PROFILE='Short' is not a profile this image has/)
    assert.match(output, /standard short/)
  })

  test('no Profile value at all says so, rather than defaulting in silence', () => {
    // The original bug in one assertion: this is the case that produced no
    // output whatsoever, and it is the case a mis-plumbed portal field lands in.
    const output = said({})
    assert.match(output, /no Profile value reached this task/)
    assert.ok(phasesIn(output).some((key) => key.startsWith('journey_')))
  })

  test('a resolved profile is announced, including which variable carried it', () => {
    assert.match(said({ PROFILE: 'short' }), /profile: PROFILE='short'/)
    assert.match(said({ TEST_SCENARIO: 'short' }), /profile: TEST_SCENARIO='short'/)
  })

  test('TEST_SCENARIO still names a profile, for a local run and the compose file', () => {
    const phases = phasesIn(run({ TEST_SCENARIO: 'short' }))
    assert.ok(
      phases.every((key) => key.startsWith('saturate_')),
      'TEST_SCENARIO=short must keep working outside CDP'
    )
  })

  test('an unknown TEST_SCENARIO still runs, at the default profile', () => {
    // The base image bakes ENV TEST_SCENARIO=test for its own sample plan. A
    // stale placeholder must never fail the run.
    const phases = phasesIn(run({ TEST_SCENARIO: 'test' }))
    assert.ok(phases.some((key) => key.startsWith('journey_')))
    assert.ok(!phases.some((key) => key.startsWith('saturate_')))
  })

  test('a stale PERF_PROFILE cannot override the portal field', () => {
    // Two knobs for one decision means whichever loses is a setting that
    // silently does nothing — and a PERF_PROFILE left on a task from an earlier
    // run would have quietly beaten what someone typed into the portal.
    const phases = phasesIn(run({ PROFILE: 'short', PERF_PROFILE: 'standard' }))
    assert.ok(
      phases.every((key) => key.startsWith('saturate_')),
      'PROFILE=short must win over a leftover PERF_PROFILE'
    )
  })

  test('and PERF_PROFILE alone selects nothing', () => {
    // It is ignored rather than honoured, so it must not quietly work either.
    const phases = phasesIn(run({ PERF_PROFILE: 'short' }))
    assert.ok(phases.some((key) => key.startsWith('journey_')))
    assert.ok(!phases.some((key) => key.startsWith('saturate_')))
  })

  test('unset runs the whole suite', () => {
    const phases = phasesIn(run({}))
    assert.ok(phases.some((key) => key.startsWith('journey_')))
  })
})

describe('the saturation cutoff', () => {
  test('a profile with no cutoff runs everything it lists', () => {
    assert.deepEqual(phasesWithinCutoff('standard'), profilePhases('standard'))
    assert.deepEqual(phasesBeyondCutoff('standard'), [])
  })

  test('kept and skipped together account for every listed rung', () => {
    // Nothing may go missing between the two: a rung in neither list is a rung
    // that silently never ran and was never reported as unrun.
    const kept = phasesWithinCutoff('short').map((p) => p.key)
    const skipped = phasesBeyondCutoff('short').map((p) => p.key)
    assert.deepEqual(
      [...kept, ...skipped].sort(),
      profilePhases('short').map((p) => p.key).sort()
    )
  })

  test('every rung it keeps actually finishes inside the cutoff', () => {
    const cutoff = PROFILES.short.cutoffSeconds
    const scheduled = scheduleFrom(
      phasesWithinCutoff('short'),
      generatedBlockStartSeconds('short')
    )
    for (const phase of scheduled) {
      assert.ok(
        phase.delay + phase.window <= cutoff,
        `${phase.key} ends at ${phase.delay + phase.window}s, past the ${cutoff}s cutoff`
      )
    }
  })

  test('short reaches every rung it lists, with headroom to spare', () => {
    // The property the 600 s cutoff buys. It used to be 300, which dropped the
    // last five rungs — `large @ 8` and every `xlarge` rung, so the biggest
    // fixture had never been saturation-tested at all.
    //
    // The margin is asserted as well as the fit, because the cutoff is a
    // CEILING rather than a duration: raising it costs nothing when the ladder
    // is shorter, and a run that only just fits is one window tweak away from
    // silently losing its tail again. If this fails, either extend the cutoff
    // or decide deliberately which rungs to drop.
    assert.deepEqual(phasesBeyondCutoff('short'), [])
    const margin = PROFILES.short.cutoffSeconds - runSeconds('short')
    assert.ok(margin >= 30, `only ${margin}s of headroom under the cutoff`)
  })

  test('it keeps a contiguous PREFIX rather than cherry-picking what fits', () => {
    // The tempting bug is to skip an expensive rung and take a later cheap one.
    // That would silently reorder the staircase and produce, say, an xlarge rung
    // with no large rungs beneath it to read it against.
    const all = profilePhases('short').map((p) => p.key)
    const kept = phasesWithinCutoff('short').map((p) => p.key)
    assert.deepEqual(kept, all.slice(0, kept.length))
  })

  test('every size that runs at all gets enough rungs to bracket a knee', () => {
    // A single rung brackets nothing: it can say "refused here" or "clear here",
    // never "clear at N, refused at M". So a size is either measured properly or
    // reported as not measured — a lone rung is the useless middle, and it looks
    // like data.
    //
    // This deliberately does NOT pin which sizes run. That is a weighting
    // decision in the profile, and it has changed once already: an earlier mix
    // guaranteed two xlarge rungs, and tightening normal/busy to get quotable
    // knees spent that budget. What must hold either way is that whatever runs
    // is interpretable.
    const bySize = new Map()
    for (const phase of phasesWithinCutoff('short')) {
      const size = phase.key.replace('saturate_', '').replace(/_\d+$/, '')
      bySize.set(size, (bySize.get(size) ?? 0) + 1)
    }
    assert.ok(bySize.size > 0, 'the profile must run something')
    for (const [size, count] of bySize) {
      assert.ok(count >= 2, `${size} has only ${count} rung inside the cutoff`)
    }
  })

  test('the saturation ladder climbs within each size', () => {
    // A staircase that does not climb cannot find a knee — and with a prefix
    // cutoff, an unsorted ladder would also truncate in the wrong place.
    const bySize = new Map()
    for (const phase of phasesWithinCutoff('short')) {
      const size = phase.key.replace('saturate_', '').replace(/_\d+$/, '')
      bySize.set(size, [...(bySize.get(size) ?? []), phase.users])
    }
    for (const [size, users] of bySize) {
      assert.deepEqual(users, [...users].sort((a, b) => a - b), `${size} does not climb`)
    }
  })
})

describe('time budgets', () => {
  // The reason this file exists in its current shape. A perf run that takes
  // longer than someone will wait measures nothing, because they stop running
  // it — so `standard` has a hard ceiling, and it is checked here rather than
  // rediscovered on the clock.
  for (const [name, profile] of Object.entries(PROFILES)) {
    if (!profile.budgetMinutes) {
      continue
    }
    test(`${name} fits its ${profile.budgetMinutes}-minute budget`, () => {
      const check = budgetCheck(name)
      assert.ok(
        check.fits,
        `${name} projects ${check.projectedSeconds}s ` +
          `(plan ${check.planSeconds}s + ~${check.setupSeconds}s setup) ` +
          `against a ${check.limitSeconds}s budget — ` +
          `${-check.marginSeconds}s over. Trim a ladder or move the ceiling on purpose.`
      )
    })
  }

  test('the budget accounts for setup, not just the JMeter plan', () => {
    // runSeconds is the plan's nominal length. The task someone waits for also
    // mints a token, seeds, stages four uploads through a virus scanner and
    // publishes a report — and staging is the bulk of it. A budget checked
    // against the plan alone would pass here and overrun in practice.
    const check = budgetCheck('standard')
    assert.ok(check.projectedSeconds > check.planSeconds)
    assert.equal(check.projectedSeconds, check.planSeconds + SETUP_ALLOWANCE_SECONDS)
  })

})

describe('entrypoint.sh derives the same schedule this config does', () => {
  // The windows are computed in JS and handed to the shell; the DELAYS are
  // accumulated by the shell, so that changing a window or PHASE_GAP_SECONDS at
  // run time still slides everything after it. That split means two
  // implementations of the same arithmetic, and two implementations drift. This
  // is the check that they have not.
  for (const name of Object.keys(PROFILES)) {
    test(`${name} matches`, () => {
      const dumped = execFileSync('sh', [join(ROOT, 'entrypoint.sh')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          JM_HOME: ROOT,
          ENVIRONMENT: 'local',
          // PROFILE, not PERF_PROFILE and not TEST_SCENARIO: this is the
          // variable a CDP task actually carries, so driving it any other way
          // would test a path no real run uses.
          PROFILE: name,
          TEST_SCENARIO: '',
          PERF_PROFILE: '',
          PERF_DUMP_SCHEDULE: 'true'
        },
        stdio: ['ignore', 'pipe', 'ignore']
      })

      // Marker-prefixed lines only — the config banner shares this stream.
      const fromShell = dumped
        .split('\n')
        .filter((line) => line.startsWith('PHASE '))
        .map((line) => line.split(' '))
        .map(([, key, users, window, delay]) => ({
          key,
          users: Number(users),
          window: Number(window),
          delay: Number(delay)
        }))

      // The shell starts the ladder after the size ramp, whose length is a
      // profile knob — so take the first phase's delay as the anchor rather
      // than assuming the .jmx default. What is being compared is the SHAPE:
      // the same phases, the same windows, the same gaps between them.
      const anchor = fromShell.length ? fromShell[0].delay : 0
      // No gap override: each phase carries its own drain time, and the point of
      // this test is that the shell honours the same ones.
      //
      // `phasesWithinCutoff`, not `profilePhases`: a profile with a cutoff runs
      // a PREFIX of what it lists, and the shell is handed that prefix. Comparing
      // against the full list would fail on the rungs the cutoff drops — which
      // is exactly what it did when the cutoff was introduced.
      const fromConfig = scheduleFrom(phasesWithinCutoff(name), anchor).map(
        ({ key, users, window, delay }) => ({
        key,
        // The mixed workload has no user count in the ladder tables; the shell
        // gives it MIXED_THREADS.
          users: users ?? fromShell.find((p) => p.key === key)?.users ?? 0,
          window,
          delay
        })
      )

      assert.deepEqual(fromShell, fromConfig)
    })
  }
})

describe('the committed plan', () => {
  test('no typed prop carries a ${...} expression', () => {
    // `intProp`, `longProp` and `boolProp` are parsed as literals the moment
    // JMeter loads the XML, so a property function inside one fails the ENTIRE
    // plan before a single sampler runs:
    //
    //   NumberFormatException: For input string: "${__P(saturateGateTimeoutMs,120000)}"
    //
    // Nothing catches that until JMeter itself parses the file, which is a
    // container away from here — so this is the cheap stand-in. A value that
    // has to be substituted belongs in a stringProp; JMeter coerces it at run
    // time. (This is a real bug the saturation SyncTimer shipped with.)
    const jmx = readFileSync(join(ROOT, 'scenarios', 'bng-perf.jmx'), 'utf8')
    const offenders = [
      ...jmx.matchAll(/<(intProp|longProp|boolProp)\s+name="([^"]+)">([^<]*)<\/\1>/g)
    ].filter(([, , , value]) => value.includes('${'))
    assert.deepEqual(
      offenders.map(([, tag, name, value]) => `${tag} ${name}=${value}`),
      [],
      'these must be stringProp, or JMeter will refuse to load the plan'
    )
  })


  test('bng-perf.jmx and ladders.sh are in step with ladders.config.mjs', () => {
    // The generated half of the plan is committed, so it can go stale the
    // moment someone edits the config without re-running the generator. This
    // is the check CI runs; it is here so it fails locally first.
    execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'gen-scenario.mjs'), '--check'],
      { cwd: ROOT, stdio: 'pipe' }
    )
  })

  test('every generated thread group is one entrypoint.sh knows how to drive', () => {
    // A thread group whose property names are not in ALL_PHASE_KEYS gets no
    // -Jusers_… from entrypoint.sh, so it silently falls back to the baked-in
    // STANDARD default and runs regardless of the active profile.
    const jmx = readFileSync(join(ROOT, 'scenarios', 'bng-perf.jmx'), 'utf8')
    const generated = jmx.slice(
      jmx.indexOf('BEGIN GENERATED'),
      jmx.indexOf('END GENERATED')
    )
    const known = new Set([
      ...LADDERS.flatMap((ladder) => ladderSteps(ladder).map(stepKey)),
      'fetchRamp',
      'mixed'
    ])
    const referenced = [...generated.matchAll(/__P\(users_(\w+),/g)].map((m) => m[1])
    assert.ok(referenced.length > 0, 'expected generated thread groups')
    for (const key of referenced) {
      assert.ok(known.has(key), `${key} has a thread group but no phase key`)
    }
  })

  test('the CSVs staging writes quoted are read as quoted', () => {
    // stage-uploads.mjs quotes every field of the prepared and contention CSVs,
    // because they carry free-text habitat and condition names. A data set that
    // read them unquoted would put the quote characters inside the JSON body of
    // the PUT — a broken request that reports as a validation failure.
    const jmx = readFileSync(join(ROOT, 'scenarios', 'bng-perf.jmx'), 'utf8')
    const dataSets = [...jmx.matchAll(/<CSVDataSet[\s\S]*?<\/CSVDataSet>/g)].map(
      (m) => m[0]
    )
    const prepared = dataSets.filter((ds) => ds.includes('preparedBroadType'))
    assert.ok(prepared.length > 0, 'expected prepared-pool data sets')
    for (const dataSet of prepared) {
      assert.match(
        dataSet,
        /<boolProp name="quotedData">true<\/boolProp>/,
        'a prepared-pool CSV data set is not reading quoted data'
      )
    }
  })

  test('no generated sampler label contains a comma', () => {
    // Labels land in the results CSV. JMeter quotes them correctly, but every
    // naive consumer of that file — a spreadsheet, a grep, an awk one-liner —
    // splits the row in the wrong place and shifts every later column.
    //
    // Scoped to the GENERATED block. Two hand-written project-list samplers
    // ("list my projects, paginated (…)") predate this and are left alone:
    // renaming them would change rows people already compare runs against, and
    // that is a call for whoever owns those groups, not a side effect of this.
    const jmx = readFileSync(join(ROOT, 'scenarios', 'bng-perf.jmx'), 'utf8')
    const generated = jmx.slice(
      jmx.indexOf('BEGIN GENERATED'),
      jmx.indexOf('END GENERATED')
    )
    const offenders = [
      ...generated.matchAll(/<HTTPSamplerProxy[^>]*testname="([^"]*)"/g)
    ]
      .map((m) => m[1])
      .filter((name) => name.includes(','))
    assert.deepEqual(offenders, [])
  })

  test('every size the ladders name is a size the fixtures define', () => {
    for (const ladder of LADDERS) {
      if (!ladder.perSize) {
        continue
      }
      for (const size of Object.keys(ladder.sizes)) {
        assert.ok(
          SIZE_LABELS.includes(size),
          `ladder ${ladder.key} names size "${size}", which has no fixture`
        )
      }
    }
  })
})
