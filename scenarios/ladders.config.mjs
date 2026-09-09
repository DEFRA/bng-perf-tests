/**
 * The shape of every staircase in the plan — one source of truth.
 *
 * `scenarios/bng-perf.jmx` used to carry each step of each staircase as its own
 * hand-written thread group: five near-identical 95-line blocks for the
 * concurrency ramp, three more for the upload journey. Adding the contiguous
 * 1..10 ladder this file now describes would have meant ten more copies, and a
 * change to one sampler would have had to be made ten times by hand.
 *
 * So the repetitive half of the plan is GENERATED (scripts/gen-scenario.mjs)
 * from the tables below, and the result is committed — the same call the repo
 * already made for the upload fixtures. The .jmx stays a real file you can open
 * in the JMeter GUI and diff; it just is not the place you edit a ladder.
 *
 * ── Why the STEPS here are a superset ────────────────────────────────────────
 *
 * A JMeter thread group has to exist in the plan before it can run, so this
 * file lists every step any profile might want. Which of them actually run is a
 * RUN-TIME decision: entrypoint.sh sets each step's thread count from the
 * active PERF_PROFILE, and a step set to 0 threads is skipped — and, because
 * the phase delays are derived rather than written down, it reserves no wall
 * clock either. That is the same contract `SIZE_RAMP_THREADS=0` already had.
 *
 * ── Why each step gets its own WINDOW ────────────────────────────────────────
 *
 * Every step used to run for a flat 30 s. That is the wrong shape: with N
 * concurrent users, samples accumulate N times faster, so a flat window
 * over-samples the top of a ladder and under-samples the bottom — while
 * charging the run its most expensive wall clock for the steps that need it
 * least.
 *
 * Each step's window is therefore DERIVED from how many samples it is meant to
 * produce:
 *
 *   window(N) = clamp(targetSamples * secondsPerIteration / N, minStep, maxStep)
 *
 * A 1-user normal journey step gets ~24 s; the 10-user step needs ~2.4 s for
 * the same sample count and lands on the 10 s floor. A contiguous 1..10 ladder
 * costs ~3 minutes rather than the ~6 a flat 30 s window would have.
 *
 * `secondsPerIteration` is an ALLOWANCE, not a measurement — the same status
 * the SIZE_ALLOWANCE_* numbers have. It only sizes the window; a faster service
 * simply fits more samples into it, and summarise-run.mjs reports what each
 * step actually produced so these can be tightened from real numbers.
 */

/**
 * Fixture labels the plan is wired to. Shared with stage-uploads.mjs, which
 * rejects an UPLOAD_SIZES spec naming anything else — a label the plan does not
 * know stages a file nothing validates.
 */
export const SIZE_LABELS = ['normal', 'busy', 'large', 'xlarge']

/**
 * Shell-safe identifiers. Step properties become `-Jname=value` arguments and
 * entrypoint.sh deliberately leaves that string unquoted so it word-splits, so
 * anything with whitespace in it would split one argument into two.
 */
export const LADDERS = [
  {
    key: 'journey',
    /**
     * The FULL upload journey — initiate, multipart POST to the CDP Uploader,
     * then validate — as one closed loop per user. This is the only staircase
     * that puts real bytes through the uploader on every iteration, so it is
     * the one that answers "what happens when N people upload N files at once".
     *
     * Run per SIZE, not just at `normal`: "10 people upload a 4 MB file at
     * once" is a different question from "10 people upload a 143 KB file at
     * once", and only the second one was ever asked before.
     */
    title: 'Upload journey',
    perSize: true,
    sizes: {
      // Contiguous 1..10: the point of a ladder is to find the knee, and
      // 1/2/5/10 cannot tell a cliff at 7 from a slope.
      normal: { steps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], secondsPerIteration: 4 },
      busy: { steps: [1, 2, 5, 10], secondsPerIteration: 6 },
      large: { steps: [1, 2, 3, 5, 8, 10], secondsPerIteration: 14 },
      xlarge: { steps: [1, 2, 5], secondsPerIteration: 30 }
    },
    targetSamples: 5
  },
  {
    key: 'revalidate',
    /**
     * The original concurrency staircase, renamed twice now.
     *
     * Every thread here re-validates ONE pre-staged upload, so it isolates the
     * service's own validate cost from the uploader's — which is what it is
     * for. It was called "Concurrency N user(s) — large file", which reads in a
     * pasted summary as "N people uploaded large files" (the journey ladder is
     * that); then "Revalidate <size> @ N user(s)", which read as a different
     * operation from the size ramp's "validate" when it is the SAME request.
     * The label now names the axis, pairing it with the size ramp's
     * "validation cost vs file size". The key stays `revalidate` because it is
     * a shell identifier shared with entrypoint.sh, not something a reader of
     * the report ever sees.
     */
    title: 'Validation cost vs concurrency',
    perSize: true,
    sizes: {
      large: { steps: [1, 2, 3, 4, 5, 10, 15, 20], secondsPerIteration: 12 },
      xlarge: { steps: [1, 2, 5], secondsPerIteration: 26 }
    },
    targetSamples: 5
  },
  {
    key: 'pi',
    /**
     * Post-intervention validate — the peer of `/baseline/validate/` that no
     * sampler in the plan had ever touched.
     *
     * It is plausibly the heavier of the two: it reconciles the upload against
     * the baseline already stored on the project (enrichOptionsForPostIntervention
     * reads storedProject.baseline), so it only means anything against a
     * project that HAS a baseline. Staging builds exactly that.
     */
    title: 'Post-intervention validate',
    perSize: true,
    sizes: {
      normal: { steps: [1, 2, 5, 10], secondsPerIteration: 5 },
      large: { steps: [1, 2, 5], secondsPerIteration: 16 }
    },
    // Three, not more: this ladder answers "does post-intervention cost more
    // than baseline", which is a comparison against the size ramp's numbers
    // rather than a percentile of its own.
    targetSamples: 3
  },
  {
    key: 'edit',
    /**
     * Habitat editing — the operation a user performs immediately after the
     * upload the rest of the plan measures, and the one nothing measured.
     *
     * Every PUT is O(document size) in three places: the handler SELECTs the
     * whole project FOR UPDATE and pulls the JSONB into Node, recalculates the
     * unit totals across it, and the write_projects_audit_log trigger stores
     * BOTH the new and the previous document. The write itself is a surgical
     * jsonb_set; nothing around it is.
     *
     * Each thread edits a DIFFERENT project, so this measures throughput rather
     * than contention. The contention ladder below is the other half.
     */
    title: 'Habitat edit (distinct projects)',
    perSize: true,
    sizes: {
      normal: { steps: [1, 2, 3, 5, 10], secondsPerIteration: 1 },
      large: { steps: [1, 2, 5], secondsPerIteration: 4 }
    },
    targetSamples: 12
  },
  {
    key: 'saturate',
    /**
     * Where the service starts REFUSING work, rather than how fast it does it.
     *
     * Every other ladder in this file is calibrated to sit below the knee and
     * asserts `Status 200`, so a 503 is a run failure. This one is the opposite
     * question — it climbs deliberately past the point where the validator
     * sheds load, and a 503 is the DATA rather than a failure.
     *
     * ── Why this one is BURST driven ─────────────────────────────────────────
     *
     * Every other ladder is a closed loop: N threads each looping for a window.
     * That is the wrong instrument here, because a refused request comes back
     * in about a second while a served one can take twenty — so refused threads
     * re-fire twenty times faster and the load actually offered climbs with the
     * refusal rate. "N users" would stop meaning "N in flight" at exactly the
     * moment it has to mean it.
     *
     * So a step here is ONE BURST: a Synchronizing Timer holds all N threads at
     * a gate, releases them together, and the loop count is `bursts` rather
     * than -1. The window becomes a SAFETY NET rather than the mechanism — the
     * group ends when its loops do.
     *
     * ── Why one burst per rung is enough ─────────────────────────────────────
     *
     * A rung produces `users x bursts` samples, so the cheap low rungs produce
     * the fewest. That is the right way round: a low rung is expected to refuse
     * NOTHING, and a handful of samples confirms a zero. The rungs where the
     * refusal rate is a real number are the wide ones, and those are exactly
     * the rungs with plenty of samples.
     */
    title: 'Saturation — where the service starts refusing',
    perSize: true,
    burst: true,
    bursts: 1,
    sizes: {
      // Steps bracket the knee as measured on a 2-vCPU box (normal 10-16,
      // large 4-6). The pool clamps to availableParallelism() - 1, so that box
      // ran ONE worker; a CDP task with more cores runs the default 2 and the
      // knee moves up. Hence steps well past the local numbers rather than
      // tight around them.
      //
      // `normal`'s 32/48/64 are a deliberately COARSE bracket rather than more
      // contiguous rungs. On 4 vCPU it served 24/24 with nothing refused, and
      // its knee cannot be extrapolated the way the other sizes' can: the model
      // that fits them — served ~= workers x (1 + 5000 ms / service time) —
      // needs a service time, and `normal`'s geometry step vanishes into the
      // fixed pipeline cost (every rung from 10 to 16 came back at a flat
      // ~1.5 s). So the knee could be anywhere from the low 30s to past 64, and
      // contiguous rungs placed by guesswork would likely all land the same
      // side of it. Bracket first, then fill in contiguous rungs on a follow-up
      // run — the path `normal` and `busy` already took to earn their 10/12/14.
      normal: { steps: [4, 8, 10, 12, 14, 16, 24, 32, 48, 64], secondsPerBurst: 7 },
      busy: { steps: [4, 8, 10, 12, 14, 16], secondsPerBurst: 9 },
      large: { steps: [2, 4, 6, 8, 12], secondsPerBurst: 17 },
      xlarge: { steps: [2, 3, 4, 6], secondsPerBurst: 31 }
    }
  },
  {
    key: 'editContention',
    /**
     * The same PUT, with every thread aimed at ONE project.
     *
     * runUpdate takes `SET LOCAL lock_timeout = '5s'` then SELECT … FOR UPDATE,
     * so concurrent edits to one project serialise and eventually 409 with
     * "Another edit for this project is in progress". Nobody has measured where
     * that 5 s timeout starts firing. The number to read here is the 409 rate,
     * not the latency — summarise-run.mjs reports it separately for that reason.
     */
    title: 'Habitat edit (same project)',
    perSize: false,
    steps: [2, 3, 5, 10],
    secondsPerIteration: 1,
    targetSamples: 12
  }
]

/**
 * Wall-clock guards every derived window is clamped into.
 *
 * The floor keeps a high-concurrency step long enough to be a measurement
 * rather than a burst.
 *
 * The ceiling stops a generous allowance at 1 user from quietly owning the run,
 * and it binds hard: at 14 s an iteration, a 1-user `large` journey step would
 * want 84 s for its six samples. It is set at 30 s rather than higher because a
 * ladder's 1-user step is a BASELINE FOR THAT LADDER, not the primary
 * single-upload measurement — the size ramp owns that question, at 1 user, with
 * exact loop-driven sample counts. Paying a minute and a half to measure it a
 * second time is the run's worst trade.
 */
export const WINDOW_BOUNDS = { minStepSeconds: 8, maxStepSeconds: 30 }

/**
 * What the JMeter plan's own duration does NOT include.
 *
 * `runSeconds` is the plan's nominal length. The task a person actually waits
 * for is longer: mint a stub token, seed, stage four uploads through a virus
 * scanner, build the prepared pools, then afterwards summarise and publish the
 * report to S3. None of that is in the plan's timeline, and staging is the bulk
 * of it.
 *
 * This is a conservative ESTIMATE, with the same status as the SIZE_ALLOWANCE_*
 * numbers: it only sizes the design-time budget check below. entrypoint.sh
 * measures the real figure every run and reports it, and re-checks the budget
 * against the measurement rather than against this — so a slow scanner is
 * caught on the day, not assumed away here. Tighten it from a real run.
 */
export const SETUP_ALLOWANCE_SECONDS = 90

/**
 * The profile: which steps run, at what sampling depth.
 *
 * There is exactly ONE profile. There used to be five (quick / standard / deep
 * / full / soak); the maintenance cost of keeping five step lists meaningful
 * outweighed the scheduling flexibility, so `standard` now IS the old `deep` —
 * the intermediate ladder steps, both file sizes on every ladder, and a mixed
 * workload long enough to mean something — and the others are gone.
 *
 * The profile never changes what the plan CONTAINS — steps it does not name
 * still exist in the .jmx at 0 threads, which costs nothing and reserves
 * nothing. `steps` here INTERSECTS the ladder's own list — the profile can
 * never invent a step the plan has no thread group for.
 */
export const PROFILES = {
  standard: {
    description: 'the only profile — full ladders at both file sizes, and a two-minute mixed workload',
    // A HARD ceiling, enforced by a test: this is the run a person sits and
    // waits for, and a run they stop waiting for measures nothing. If a future
    // step will not fit, trim a ladder or move the ceiling on purpose.
    budgetMinutes: 20,
    ladders: {
      journey: {
        normal: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        busy: [1, 5, 10],
        large: [1, 2, 3, 5, 10]
      },
      revalidate: { large: [1, 2, 5, 10, 20] },
      pi: { normal: [1, 2, 5, 10], large: [1, 5] },
      edit: { normal: [1, 2, 3, 5, 10], large: [1, 5] },
      editContention: [2, 3, 5, 10]
    },
    fetchRamp: true,
    mixedSeconds: 120,
    targetScale: 1,
    sizeRampLoops: { normal: 20, busy: 8, large: 3, xlarge: 2 }
  },
  short: {
    /**
     * Named for what it COSTS rather than what it does, because the name is
     * typed into the CDP portal's one text field and a short name is a name
     * people get right. What it does is in `description`, which the banner and
     * ladders.sh both print, so a run always says which question it answered.
     */
    description:
      'SATURATION — the saturation ladder only, climbing past the knee at all four file sizes, inside a ten-minute cutoff',
    /**
     * A CUTOFF, not a budget, and the difference is the point.
     *
     * `budgetMinutes` is a promise the profile keeps: a test fails if the
     * standard profile projects over it, so a step that will not fit forces a
     * decision here. This profile makes no such promise. Its ladder lists what
     * it lists, and `phasesWithinCutoff` truncates whatever will not fit — so
     * it has no budget to check, and the cutoff is what bounds the run.
     *
     * ── Why 600 rather than something tighter ────────────────────────────────
     *
     * It was 300, which kept a contiguous prefix of 14 rungs and silently
     * dropped the last five: `large @ 8` and ALL FOUR `xlarge` rungs. So the
     * 9.3 MB file had never been saturation-tested in any run, and neither had
     * `large`'s widest rung — the fixture is staged and `UPLOAD_SIZES` defaults
     * to all four sizes, so the cutoff was the only thing in the way. That was
     * a deliberate trade when contiguous 10/12/14 rungs were added to `normal`
     * and `busy`, and it aged badly: on 4 vCPU `large` served all six rungs
     * with zero refusals, so the ladder no longer reached the knee for either
     * of the two biggest files.
     *
     * The whole ladder as it now stands is 525 s: 474 s of the pre-existing
     * rungs, plus 51 s for `normal`'s three new ones at 17 s each (12 s window
     * + 5 s gap). So anything from 525 up runs it in full.
     *
     * 600 rather than 540 because THE CUTOFF IS A CEILING, NOT A DURATION. It
     * only decides which rungs are kept; it never pads a run, so every value at
     * or above the ladder's length produces an identical run and headroom is
     * free. At 540 the margin would be 15 s — one change to a window or a gap
     * and the `xlarge` tail silently drops off the end again, which is the
     * exact failure this is fixing. At 600 the margin is 75 s, and the run
     * still finishes in 525 s plus the SETUP_ALLOWANCE_SECONDS staging and
     * publishing: ~10 minutes end to end, comfortably under half the 20-minute
     * `standard` run, which is the property this profile was sized for.
     */
    budgetMinutes: null,
    cutoffSeconds: 600,
    /**
     * No home page, no project list, no create load, no background probe, no
     * size ramp. All of those exist to give the standard run its context, and
     * here they would be 55 s of the cutoff spent measuring something this
     * profile is not asking about — and load on the service while it does it,
     * which for a saturation test is contamination rather than context.
     */
    preamble: false,
    ladders: {
      journey: {},
      revalidate: {},
      pi: {},
      edit: {},
      editContention: [],
      /**
       * Every rung the ladder lists for a size, minus the cheapest few.
       *
       * The `4` rung of `normal` and `busy` and `large @ 12` are the only steps
       * left out. The first two refuse nothing on any box that has ever run
       * this and cost 17-19 s each to re-confirm a zero; the third is held in
       * reserve — see the note on `large` below.
       *
       * This used to be a much thinner mix, because at a 300 s cutoff a profile
       * that asked for every rung would have spent the whole run on `normal`
       * and `busy` and never attempted the two sizes most likely to be refused.
       * At 600 s the whole thing fits with 75 s to spare, so there is nothing
       * left to trade away.
       */
      saturate: {
        /**
         * 32/48/64 measure the one number the ladder has never produced.
         *
         * `normal` (143 KB, 80 parcels) is the everyday file — the size most
         * real uploads will be — so where it starts refusing is arguably the
         * most operationally useful number here. On 4 vCPU it served 24/24 with
         * zero refusals at the widest rung that existed, so all the ladder can
         * say today is "more than 24", and the knee cannot be extrapolated (see
         * the step list in LADDERS for why). The bracket is coarse on purpose.
         *
         * Worth going in with eyes open: a refusal at 48 or 64 may not come
         * from where the others do. At those widths the main-thread pipeline —
         * S3 download, GeoPackage parse, persistence — is doing far more work
         * than the worker pool is, so the constraint may be the event loop
         * rather than the queue. That would itself be the finding, and no
         * narrower rung can surface it.
         */
        normal: [8, 10, 12, 14, 16, 24, 32, 48, 64],
        busy: [8, 10, 12, 14, 16],
        /**
         * May still not bracket `large`: on 4 vCPU it served all six at burst 6
         * cleanly, so burst 8 may come back clean too. The fallback is cheap —
         * the ladder above already carries a `12` thread group, so switching it
         * on here is one line and +27 s.
         */
        large: [2, 4, 6, 8],
        // Extrapolating from the ~2.1 s service time measured at `large` puts
        // this knee near burst 4-6, so these rungs should bracket it. That is
        // an extrapolation, not a measurement — which is the point of finally
        // running them.
        xlarge: [2, 3, 4, 6]
      }
    },
    fetchRamp: false,
    mixedSeconds: 0,
    targetScale: 1,
    sizeRampLoops: { normal: 0, busy: 0, large: 0, xlarge: 0 }
  }
}

/**
 * The mixed workload's weights, as percent of iterations. They should add up to
 * 100 — ThroughputController does not require it, but a mix that does not is a
 * mix nobody can reason about.
 */
export const MIX_DEFAULTS = { list: 40, fetch: 25, edit: 25, validate: 10 }

/** The fetch ramp's per-size loop counts and its window, in seconds. */
export const FETCH_RAMP = {
  // Weighted like the size ramp and for the same reason — the small sizes are
  // cheap, so they can earn a percentile while the expensive ones stay a point
  // on the curve. `xlarge` is a single probe: at ~8 s a fetch it would
  // otherwise be a third of this phase for a document two orders of magnitude
  // past anything in the real corpus.
  loops: { normal: 5, busy: 3, large: 2, xlarge: 1 },
  secondsPerIteration: { normal: 1, busy: 2, large: 4, xlarge: 8 }
}

/** Threads the mixed workload runs with. */
export const MIXED_THREADS = 8

/**
 * The hand-written phases the ladder starts after, and what they cost.
 *
 * The size ramp's window is loop-count driven — `loops x allowance` per size —
 * and its ALLOWANCES are deliberately generous guards rather than
 * measurements, so a faster service finishes the pass early. The wall clock is
 * reserved either way, which is why the weights are a profile knob: at 20/8/3/2
 * the ramp is 160 s, and it sits in front of every ladder in the run.
 */
export const SIZE_ALLOWANCE_SECONDS = {
  normal: 2,
  busy: 4,
  large: 12,
  xlarge: 26
}

export const EVERYDAY_PHASE_SECONDS = 25
export const PROBE_BASELINE_SECONDS = 25

/** The size ramp's reserved window under a given profile's weights. */
export function sizeRampWindowSeconds(profileName) {
  const weights = PROFILES[profileName].sizeRampLoops
  return SIZE_LABELS.reduce(
    (total, size) => total + weights[size] * SIZE_ALLOWANCE_SECONDS[size],
    0
  )
}

/**
 * Where the generated block starts in the timeline: after the everyday groups,
 * the quiet probe baseline and the size ramp.
 *
 * Derived rather than written down, so trimming the size-ramp weights actually
 * shortens the run instead of leaving a hole in front of it. entrypoint.sh
 * computes the same figure from the durations in force at run time; this is
 * what the committed .jmx bakes in so a bare `jmeter -t` still gets a coherent
 * schedule.
 */
export function generatedBlockStartSeconds(profileName) {
  // A profile with no preamble ZEROES the three phases rather than skipping the
  // arithmetic, because entrypoint.sh derives the same figure by accumulating
  // the same terms — and it still pays both gaps, since a phase set to zero
  // still has a boundary either side of it. Short-circuiting to a different
  // number here would put the generator and the shell 5 s out of step, and a
  // test asserts they agree.
  const noPreamble = PROFILES[profileName].preamble === false
  return (
    (noPreamble ? 0 : EVERYDAY_PHASE_SECONDS) +
    DEFAULT_PHASE_GAP_SECONDS +
    (noPreamble ? 0 : PROBE_BASELINE_SECONDS) +
    sizeRampWindowSeconds(profileName) +
    DEFAULT_PHASE_GAP_SECONDS
  )
}

/**
 * The phases a profile can actually fit inside its cutoff, in order.
 *
 * A profile with no `cutoffSeconds` runs everything it lists, which is how
 * every profile behaved before this existed — the standard profile is sized to
 * fit its budget, and a step that would not fit is a decision to take in this
 * file rather than something to discover at run time.
 *
 * `short` is deliberately the other way round. It is bounded by a cutoff rather
 * than by a budget, and the cutoff decides how far up the ladder a run actually
 * gets. That is the right shape for a saturation test for one specific reason:
 * the ladder climbs, so the knee is near the BOTTOM,
 * and everything a cutoff removes is past-saturation detail whose shape is
 * already established. Truncation degrades gracefully here in a way it would
 * not for a latency ladder.
 *
 * A contiguous PREFIX is kept — the loop stops at the first step that does not
 * fit rather than skipping it and taking a cheaper one later. Skipping would
 * quietly reorder the staircase and produce a `xlarge` rung with no `large`
 * rungs beneath it to read it against.
 *
 * Steps that do not fit are simply absent: no thread group runs, so they
 * produce no samples, and summarise-run.mjs reports them as NOT MEASURED. That
 * distinction is load-bearing — a rung with no samples read as "nothing was
 * refused" would claim capacity that was never tested.
 */
export function phasesWithinCutoff(profileName) {
  const profile = PROFILES[profileName]
  const all = profilePhases(profileName)
  if (!profile.cutoffSeconds) {
    return all
  }
  const kept = []
  let cursor = generatedBlockStartSeconds(profileName)
  for (const phase of all) {
    if (cursor + phase.window > profile.cutoffSeconds) {
      break
    }
    kept.push(phase)
    cursor += phase.window + phase.gap
  }
  return kept
}

/** Steps a profile lists but cannot reach inside its cutoff. */
export function phasesBeyondCutoff(profileName) {
  const kept = new Set(phasesWithinCutoff(profileName).map((phase) => phase.key))
  return profilePhases(profileName).filter((phase) => !kept.has(phase.key))
}

/** The whole run, end to end, under a profile's own defaults. */
export function runSeconds(profileName) {
  const scheduled = scheduleFrom(
    phasesWithinCutoff(profileName),
    generatedBlockStartSeconds(profileName)
  )
  return scheduled.length
    ? scheduled.at(-1).delay + scheduled.at(-1).window
    : generatedBlockStartSeconds(profileName)
}

/** The profile the committed .jmx bakes in as its own defaults. */
export const DEFAULT_PROFILE = 'standard'

/**
 * Dead time between phases, so one phase's stragglers drain before the next and
 * its latencies are not charged to the wrong phase.
 *
 * It used to be a flat 5 s everywhere, which across 25 phases was 125 s — a
 * fifth of the ladder — spent waiting for requests that had mostly already
 * finished. What a phase actually needs is roughly **one in-flight request**:
 * an `edit` iteration takes about a second, so five seconds of silence after it
 * is four seconds of nothing. A `large` journey iteration takes fourteen, and
 * that one genuinely needs the full gap.
 *
 * So the gap is derived from the same per-iteration allowance the window is,
 * and clamped: never less than a second (a gap of zero would let a phase's tail
 * land inside the next phase's first samples), never more than the old flat
 * value. summarise-run.mjs already attributes a probe sample caught in an
 * overlap to the DRAINING phase, so a gap that turns out slightly short is
 * reported correctly rather than silently mixing two phases together.
 */
export const PHASE_GAP_BOUNDS = { minSeconds: 1, maxSeconds: 5 }

/**
 * The per-step time allowance a ladder works in, whichever kind it is.
 *
 * A closed-loop ladder is priced per iteration, a burst ladder per burst. Both
 * answer the same question for the caller — "roughly how long is one unit of
 * work here" — which is what the drain gap is derived from.
 */
export function stepAllowanceSeconds(ladder, size) {
  if (ladder.burst) {
    return ladder.sizes[size].secondsPerBurst
  }
  return ladder.perSize
    ? ladder.sizes[size].secondsPerIteration
    : ladder.secondsPerIteration
}

/** The gap after a phase whose iterations cost `secondsPerIteration`. */
export function phaseGapSeconds(secondsPerIteration) {
  return Math.min(
    PHASE_GAP_BOUNDS.maxSeconds,
    Math.max(PHASE_GAP_BOUNDS.minSeconds, Math.ceil(secondsPerIteration))
  )
}

/**
 * The gap used where there is no per-iteration figure to derive one from — the
 * boundaries around the hand-written phases (everyday groups, probe baseline,
 * size ramp), and the fetch ramp and mixed workload, whose iterations vary.
 */
export const DEFAULT_PHASE_GAP_SECONDS = PHASE_GAP_BOUNDS.maxSeconds

const PERCENT = 100

/**
 * How long one step runs.
 *
 * With N concurrent users, samples accumulate N times faster — so a step's
 * window is the wall clock it needs to produce `targetSamples`, not a flat
 * number repeated up the ladder. That is what makes a contiguous 1..10 ladder
 * affordable: the expensive windows are at the bottom, where one user has to
 * wait out each iteration in turn, and the top of the ladder lands on the floor.
 */
export function windowSeconds({ ladder, size, users }, targetScale = 1) {
  if (ladder.burst) {
    return burstWindowSeconds({ ladder, size })
  }
  const perIteration = ladder.perSize
    ? ladder.sizes[size].secondsPerIteration
    : ladder.secondsPerIteration
  const target = Math.max(1, Math.round(ladder.targetSamples * targetScale))
  const needed = Math.ceil((target * perIteration) / users)
  return Math.min(
    WINDOW_BOUNDS.maxStepSeconds,
    Math.max(WINDOW_BOUNDS.minStepSeconds, needed)
  )
}

/**
 * Headroom on top of a burst's own allowance, so the window is a SAFETY NET
 * rather than the thing that ends the step.
 *
 * A burst step is loop-count driven: it finishes when its threads have done
 * their bursts, and the window only bites if something has gone wrong. That
 * distinction is the whole reason this ladder can exist inside a plan whose
 * every other step is duration-driven — a saturating burst's duration is set by
 * its slowest request, which is the quantity being discovered, so it cannot be
 * predicted well enough to be a deadline. Slack makes a mis-estimate cost a few
 * seconds of dead air instead of a truncated burst reported as a clean one.
 */
const BURST_SLACK_SECONDS = 5

/**
 * A burst step's window: what one burst is allowed to take, plus slack.
 *
 * NOT divided by `users`, which is the difference that matters. Every other
 * window here shrinks as concurrency climbs, because N threads in a closed loop
 * produce samples N times faster. A burst is one simultaneous round no matter
 * how wide it is, so it takes as long as its slowest single request whether
 * that round is 2 requests or 24 — and a wide round is if anything SLOWER,
 * because the queue behind it is deeper.
 */
export function burstWindowSeconds({ ladder, size }) {
  return ladder.sizes[size].secondsPerBurst * ladder.bursts + BURST_SLACK_SECONDS
}

/** The fetch ramp's window, derived from its loop counts the same way. */
export function fetchRampWindowSeconds(targetScale = 1) {
  return SIZE_LABELS.reduce(
    (total, size) =>
      total +
      Math.round(FETCH_RAMP.loops[size] * targetScale) *
        FETCH_RAMP.secondsPerIteration[size],
    0
  )
}

/**
 * Every phase a profile runs, in the order it runs them, with the window each
 * one gets. A step the profile does not enable is absent rather than present
 * with zero threads — that is what lets it reserve no wall clock.
 *
 * The order is: each ladder in the order declared above, by size and then by
 * ascending user count, then the fetch ramp, then the mixed workload. Ascending
 * within a ladder matters — a staircase that does not climb is not a staircase,
 * and a heavy step leaves the service warmer than the step below it would find.
 */
export function profilePhases(profileName) {
  const profile = PROFILES[profileName]
  if (!profile) {
    throw new Error(
      `unknown profile "${profileName}" — expected one of ${Object.keys(PROFILES).join(', ')}`
    )
  }
  const phases = []
  for (const ladder of LADDERS) {
    const enabled = enabledStepsFor(profile, ladder)
    const ordered = ladderSteps(ladder)
      .filter((step) =>
        (ladder.perSize ? enabled[step.size] : enabled).includes(step.users)
      )
      .sort(bySizeThenUsers)
    for (const step of ordered) {
      phases.push({
        key: stepKey(step),
        users: step.users,
        window: windowSeconds(step, profile.targetScale),
        gap: phaseGapSeconds(stepAllowanceSeconds(ladder, step.size))
      })
    }
  }
  if (profile.fetchRamp) {
    phases.push({
      key: 'fetchRamp',
      users: 1,
      window: fetchRampWindowSeconds(profile.targetScale),
      gap: DEFAULT_PHASE_GAP_SECONDS
    })
  }
  if (profile.mixedSeconds > 0) {
    phases.push({
      key: 'mixed',
      users: null,
      window: profile.mixedSeconds,
      gap: DEFAULT_PHASE_GAP_SECONDS
    })
  }
  return phases
}

function bySizeThenUsers(a, b) {
  const sizeDelta =
    SIZE_LABELS.indexOf(a.size ?? '') - SIZE_LABELS.indexOf(b.size ?? '')
  return sizeDelta !== 0 ? sizeDelta : a.users - b.users
}

/**
 * The steps a profile enables for one ladder, intersected with the steps the
 * plan has a thread group for. A profile can narrow the plan; it can never
 * invent a step that does not exist in it.
 */
export function enabledStepsFor(profile, ladder) {
  if (profile.ladders === 'all') {
    return ladder.perSize
      ? Object.fromEntries(
          Object.entries(ladder.sizes).map(([size, spec]) => [size, spec.steps])
        )
      : ladder.steps
  }
  const wanted = profile.ladders[ladder.key]
  if (!ladder.perSize) {
    const available = new Set(ladder.steps)
    return (wanted ?? []).filter((n) => available.has(n))
  }
  return Object.fromEntries(
    Object.entries(ladder.sizes).map(([size, spec]) => {
      const available = new Set(spec.steps)
      return [size, (wanted?.[size] ?? []).filter((n) => available.has(n))]
    })
  )
}

/**
 * Walk a profile's phases and hand each one its absolute start delay.
 *
 * JMeter starts a thread group at an absolute delay from the start of the run,
 * so this is the arithmetic that has to be right: miss it and two phases
 * overlap, which fails nothing and simply makes a concurrency figure stop
 * meaning what its label says. entrypoint.sh runs the identical accumulation in
 * sh so an operator can change a window and have the timeline follow.
 */
export function scheduleFrom(phases, startAtSeconds, gapOverride) {
  let cursor = startAtSeconds
  return phases.map((phase) => {
    const scheduled = { ...phase, delay: cursor }
    // An explicitly-set gap applies to every phase — an operator who sets
    // PHASE_GAP_SECONDS is asking for a uniform one, and from there the
    // arithmetic is theirs, as it already was for an explicitly-set delay.
    cursor += phase.window + (gapOverride ?? phase.gap)
    return scheduled
  })
}

/** Percent → the integer sh can carry, since sh has no floating point. */
export function asPercent(fraction) {
  return Math.round(fraction * PERCENT)
}

/** Every step of a ladder, flattened to `{ ladder, size, users }`. */
export function ladderSteps(ladder) {
  if (!ladder.perSize) {
    return ladder.steps.map((users) => ({ ladder, size: null, users }))
  }
  return Object.entries(ladder.sizes).flatMap(([size, spec]) =>
    spec.steps.map((users) => ({ ladder, size, users, spec }))
  )
}

/**
 * The property-name suffix identifying one step. `journey_normal_3`,
 * `editContention_5`. Used for both the thread count and the delay, so the
 * generated .jmx and entrypoint.sh cannot drift apart on naming.
 */
export function stepKey({ ladder, size, users }) {
  return size ? `${ladder.key}_${size}_${users}` : `${ladder.key}_${users}`
}

/** The sampler label suffix a step's samples carry into the results CSV. */
export function stepLabel({ size, users }) {
  return size ? `(${size}) @ ${users} user(s)` : `@ ${users} user(s)`
}

/**
 * Does a profile fit its own time budget, once setup is accounted for?
 *
 * Returns null for a profile with no budget. Otherwise returns the projection
 * and whether it fits, so the caller can decide whether that is a warning or a
 * failure — the
 * test treats it as a failure, entrypoint.sh as a warning against the MEASURED
 * setup time rather than the estimate.
 */
export function budgetCheck(profileName, setupSeconds = SETUP_ALLOWANCE_SECONDS) {
  const budget = PROFILES[profileName].budgetMinutes
  if (!budget) {
    return null
  }
  const limitSeconds = budget * SECONDS_PER_MINUTE
  const projectedSeconds = runSeconds(profileName) + setupSeconds
  return {
    profile: profileName,
    limitSeconds,
    planSeconds: runSeconds(profileName),
    setupSeconds,
    projectedSeconds,
    fits: projectedSeconds <= limitSeconds,
    marginSeconds: limitSeconds - projectedSeconds
  }
}

const SECONDS_PER_MINUTE = 60
