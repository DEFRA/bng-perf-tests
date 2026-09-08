/**
 * Where does the service start saying "busy"?
 *
 * Everything else in this repo is calibrated to sit BELOW the knee. The JMeter
 * ladders assert `Status 200` on every validate, so a 503 there is a test
 * failure rather than a recorded data point — which is the right call for a
 * suite whose job is to measure latency, and the wrong tool for the question
 * "how many concurrent uploads can this instance take before it starts
 * refusing them". Nothing measured that. The refusal thresholds were only ever
 * derived from the config:
 *
 *   admission cap  = workerCount + workerQueueLimit          (default 2 + 8)
 *   budget cap     = parseBudgetBytes / (2 MB + 10 x fileSize)  (default 550 MiB)
 *
 * and the effective ceiling is whichever binds first. This script measures it
 * instead. It climbs a ladder of concurrency levels, fires each level as a
 * SIMULTANEOUS burst at `/baseline/validate/{uploadId}`, and reports the level
 * at which 503s first appear and the level at which the service is refusing
 * most of what it is offered.
 *
 * ── Why one staged upload, hit many times ────────────────────────────────────
 *
 * `/baseline/validate/{uploadId}` is not single-use: it re-reads the object
 * from S3 on every call. So the bytes are uploaded and virus-scanned ONCE, and
 * the burst is pure validate load. Staging N copies would multiply the slowest
 * part of setup by N and change nothing about what is measured. This is the
 * same trick stage-uploads.mjs plays for the `revalidate` ladder.
 *
 * ── Why each concurrent request gets its own project ─────────────────────────
 *
 * A validate that carries a `projectId` persists the result, and concurrent
 * writes to one project serialise on a row lock and eventually 409. Two threads
 * sharing a project would measure the lock rather than the refusal, so the
 * probe hands every request in a burst a different project. `--no-project`
 * drops the projectId entirely: validation then stops after the geometry
 * checks, which needs no pool at all and isolates the worker pool and parse
 * budget from the database. Both are worth running — see `--help`.
 *
 * ── Why the report carries a measured overlap ────────────────────────────────
 *
 * A concurrency instrument that quietly fails to be concurrent reports a knee
 * that is really a client-side bottleneck. Every request's start and end are
 * recorded and the maximum number in flight AT THE CLIENT is computed per step,
 * so a step labelled "24 users" that only ever got 9 sockets open says so
 * rather than being read as a service limit.
 *
 * Usage:  node scripts/saturation-probe.mjs --help
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPTS_DIR = import.meta.dirname
const ROOT_DIR = join(SCRIPTS_DIR, '..')

const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_CONFLICT = 409
const HTTP_SERVICE_UNAVAILABLE = 503

/** The error code the validate route puts in the body of its own 503. */
const BUSY_ERROR_CODE = 'VALIDATION_BUSY'

/**
 * What one request turned into. Deliberately more than pass/fail — a 503 from
 * the validator and a 503 from Hapi's RSS load limit mean different things, and
 * a 409 means the probe's own project pool is too small rather than anything
 * about the service.
 */
export const OUTCOME = Object.freeze({
  /** The file was looked at. `valid: false` still counts — the service coped. */
  ok: 'ok',
  /** 503 carrying VALIDATION_BUSY: the validator shed this one deliberately. */
  busy: 'busy',
  /** 503 without it: Hapi refused the request before the handler ran. */
  overloaded: 'overloaded',
  /** 409: two requests hit one project. A probe bug, not a service limit. */
  conflict: 'conflict',
  /** Anything else, including a transport failure or a timeout. */
  error: 'error'
})

const PERCENT = 100
const P50 = 50
const P95 = 95

/** Climbs past the shipped admission cap of 10 without wasting steps below it. */
const DEFAULT_LADDER = '1,2,4,6,8,10,12,16,20,24,32'
const DEFAULT_SIZE = 'large'
const DEFAULT_ROUNDS = 1
const DEFAULT_SETTLE_MS = 3000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_STOP_RATE = 0.5
const DEFAULT_UPLOAD_READY_TIMEOUT_MS = 180_000
const UPLOAD_POLL_INTERVAL_MS = 1000
const ERROR_SNIPPET_MAX = 300
const BYTES_PER_KB = 1024
const MS_PER_SECOND = 1000

/**
 * Extra settle time after a step that was refused, on top of `--settle-ms`.
 *
 * A step that saturated leaves workers holding files the next step would
 * inherit, which would attribute one step's backlog to the step above it. The
 * service's own answer to "when should I come back" is Retry-After, so that is
 * what is waited — read off the response rather than hard-coded, so a service
 * configured to a different pace is followed rather than guessed at.
 */
const FALLBACK_RETRY_AFTER_SECONDS = 5

// ── the pure half: parsing, classifying, summarising ─────────────────────────

/**
 * Read a ladder spec like `1,2,4,8` into ascending, de-duplicated steps.
 *
 * Strict, for the same reason stage-uploads.mjs is strict about its size specs:
 * a silently dropped step leaves a hole in the ladder that nothing in the
 * report would explain, and a ladder that does not climb cannot find a knee.
 *
 * @param {string} spec comma-separated positive integers
 * @returns {number[]}
 */
export function parseLadder(spec) {
  const steps = String(spec ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const users = Number(entry)
      if (!Number.isInteger(users) || users < 1) {
        throw new Error(
          `bad ladder step "${entry}" — steps are positive integers, e.g. 1,2,4,8`
        )
      }
      return users
    })
  if (!steps.length) {
    throw new Error('the ladder is empty — give at least one step, e.g. --ladder 1,2,4')
  }
  return [...new Set(steps)].sort((a, b) => a - b)
}

/**
 * Which of the five outcomes a response was.
 *
 * The 503s are split on the body rather than the status because the two kinds
 * have different remedies: VALIDATION_BUSY is the validator shedding load on
 * purpose and is the thing this probe is looking for, while a bare 503 is
 * Hapi's RSS limit refusing the request before the route ever saw it — which,
 * at the shipped default of `VALIDATION_MAX_RSS_BYTES=0`, should not happen at
 * all, and seeing one is itself the finding.
 *
 * @param {{ status: number, body: object|null }} response
 * @returns {string} one of OUTCOME
 */
export function classifyResponse({ status, body }) {
  if (status === HTTP_SERVICE_UNAVAILABLE) {
    const busy = body?.errors?.some((error) => error?.code === BUSY_ERROR_CODE)
    return busy ? OUTCOME.busy : OUTCOME.overloaded
  }
  if (status === HTTP_CONFLICT) {
    return OUTCOME.conflict
  }
  // A 200 with `valid: false` is still the service coping: it read the file and
  // reached a verdict. Only refusals and failures are anything else.
  return status === HTTP_OK ? OUTCOME.ok : OUTCOME.error
}

/**
 * Nearest-rank percentile over an already-sorted array. Nearest-rank rather
 * than interpolated because these are small samples — a step of 4 requests has
 * 4 real numbers in it, and inventing a fifth between two of them reports a
 * latency nothing measured.
 *
 * @param {number[]} sorted ascending
 * @param {number} p 0-100
 * @returns {number|null} null for an empty sample
 */
export function percentile(sorted, p) {
  if (!sorted.length) {
    return null
  }
  const rank = Math.ceil((p / PERCENT) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

/**
 * The greatest number of requests that were in flight at the same moment,
 * measured from the client's own clock.
 *
 * This is the honesty check on the whole instrument. The step asks for N at
 * once; if the runtime, a proxy or a connection pool serialised them, the true
 * concurrency was lower and the step's label would otherwise overstate what the
 * service was actually offered.
 *
 * A sweep over start/end events rather than a pairwise comparison, so a step of
 * 32 costs 64 sorted events rather than 1,024 comparisons.
 *
 * @param {Array<{ startedAt: number, endedAt: number }>} intervals
 * @returns {number}
 */
export function maxOverlap(intervals) {
  const events = []
  for (const { startedAt, endedAt } of intervals) {
    events.push({ at: startedAt, delta: 1 })
    events.push({ at: endedAt, delta: -1 })
  }
  // Ends before starts at the same instant: two requests that merely touch were
  // never actually in flight together.
  events.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let live = 0
  let peak = 0
  for (const event of events) {
    live += event.delta
    peak = Math.max(peak, live)
  }
  return peak
}

/**
 * Collapse one step's requests into the row the report prints.
 *
 * @param {{ users: number, results: Array<object> }} step
 * @returns {object}
 */
export function summariseStep({ users, results }) {
  const counts = Object.fromEntries(
    Object.values(OUTCOME).map((outcome) => [
      outcome,
      results.filter((result) => result.outcome === outcome).length
    ])
  )
  const latencies = results.map((result) => result.durationMs).sort((a, b) => a - b)
  const retryAfters = results
    .map((result) => result.retryAfterSeconds)
    .filter((seconds) => Number.isFinite(seconds))
  const refused = counts[OUTCOME.busy] + counts[OUTCOME.overloaded]
  return {
    users,
    sent: results.length,
    ...counts,
    refused,
    refusedRate: results.length ? refused / results.length : 0,
    p50Ms: percentile(latencies, P50),
    p95Ms: percentile(latencies, P95),
    maxMs: latencies.at(-1) ?? null,
    maxOverlap: maxOverlap(results),
    retryAfterSeconds: retryAfters.length ? Math.max(...retryAfters) : null
  }
}

/**
 * Read the knee off the finished ladder.
 *
 * Three numbers, because they answer three different questions and a single
 * "saturation point" would blur them:
 *
 *   clearTo      the highest level at which NOTHING was refused. This is the
 *                one to quote as capacity, and the one to guard a regression
 *                against, because it is the last level a user could rely on.
 *   firstRefusedAt  where shedding starts. Between this and `clearTo` there is
 *                nothing — they are adjacent rungs — so the true knee lies
 *                between them and the ladder's resolution is the error bar.
 *   saturatedAt  where the majority of an offered burst is turned away. Past
 *                here the service is in steady load-shed, not on a knee.
 *
 * @param {Array<object>} steps summarised, in ascending order of users
 * @param {{ stopRate: number }} options
 * @returns {{ clearTo: number|null, firstRefusedAt: number|null, saturatedAt: number|null }}
 */
export function findKnee(steps, { stopRate }) {
  const firstRefused = steps.find((step) => step.refused > 0) ?? null
  const saturated = steps.find((step) => step.refusedRate >= stopRate) ?? null
  // The last CLEAN rung below the first refused one — not simply "the biggest
  // step with no refusals", which would skip over a refusal and claim capacity
  // the ladder had already disproved.
  const clean = firstRefused
    ? steps.filter((step) => step.users < firstRefused.users)
    : steps
  const clearTo = clean.length && clean.every((step) => step.refused === 0)
    ? clean.at(-1).users
    : null
  return {
    clearTo,
    firstRefusedAt: firstRefused?.users ?? null,
    saturatedAt: saturated?.users ?? null
  }
}

const COLUMNS = [
  { key: 'users', title: 'users' },
  { key: 'sent', title: 'sent' },
  { key: OUTCOME.ok, title: '200' },
  { key: OUTCOME.busy, title: '503 busy' },
  { key: OUTCOME.overloaded, title: '503 rss' },
  { key: OUTCOME.conflict, title: '409' },
  { key: OUTCOME.error, title: 'err' },
  { key: 'refusedPct', title: 'refused' },
  { key: 'maxOverlap', title: 'inflight' },
  { key: 'p50Ms', title: 'p50' },
  { key: 'p95Ms', title: 'p95' },
  { key: 'maxMs', title: 'max' }
]

function cellValue(step, key) {
  if (key === 'refusedPct') {
    return `${Math.round(step.refusedRate * PERCENT)}%`
  }
  if (key.endsWith('Ms')) {
    return step[key] == null ? '-' : `${Math.round(step[key])}ms`
  }
  return String(step[key])
}

/**
 * The ladder as a fixed-width table. Right-aligned so the columns that matter —
 * the refusal counts — read down the page as a shape rather than as numbers.
 *
 * @param {Array<object>} steps
 * @returns {string}
 */
export function formatTable(steps) {
  const rows = steps.map((step) =>
    COLUMNS.map((column) => cellValue(step, column.key))
  )
  const widths = COLUMNS.map((column, index) =>
    Math.max(column.title.length, ...rows.map((row) => row[index].length))
  )
  const line = (cells) =>
    cells.map((cell, index) => cell.padStart(widths[index])).join('  ')
  return [
    line(COLUMNS.map((column) => column.title)),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line)
  ].join('\n')
}

/**
 * The prose the report ends on — what the ladder found, in the terms someone
 * pasting it into a ticket needs.
 *
 * @param {{ knee: object, steps: Array<object>, ladder: number[], stopRate: number }} report
 * @returns {string[]}
 */
export function verdictLines({ knee, steps, ladder, stopRate }) {
  const top = ladder.at(-1)
  const reached = steps.at(-1)?.users ?? null
  if (knee.firstRefusedAt === null) {
    return [
      `No refusals up to ${reached} concurrent — the service did not saturate on this ladder.`,
      `The knee is somewhere above ${reached}. Raise --ladder past ${top} to find it.`
    ]
  }
  if (knee.clearTo === null) {
    return [
      `Refused from the very first step (${knee.firstRefusedAt} concurrent).`,
      'Nothing here measures a knee: the service was already shedding before the ' +
        'ladder began. Check it is idle, and that another run is not still draining.'
    ]
  }
  const lines = [
    `Clear to ${knee.clearTo} concurrent; first refusal at ${knee.firstRefusedAt}.`,
    `The knee lies between ${knee.clearTo} and ${knee.firstRefusedAt} — ` +
      'the gap is this ladder\'s resolution, so narrow the steps there to tighten it.'
  ]
  if (knee.saturatedAt !== null) {
    lines.push(
      `At ${knee.saturatedAt} concurrent, ${Math.round(stopRate * PERCENT)}% or more ` +
        'of an offered burst is refused — steady load-shed rather than a knee.'
    )
  }
  return lines
}

// ── the IO half ──────────────────────────────────────────────────────────────

const note = (message) => process.stderr.write(`${message}\n`)
const out = (message) => process.stdout.write(`${message}\n`)

const USAGE = `
Find the concurrency at which the backend starts refusing GeoPackage
validations with a 503.

  node scripts/saturation-probe.mjs [options]

Options
  --size <label>        fixture to hammer: normal | busy | large | xlarge
                        (default: ${DEFAULT_SIZE}). Bigger files reach the parse
                        budget sooner; smaller ones reach the queue instead.
  --ladder <csv>        concurrency levels to climb
                        (default: ${DEFAULT_LADDER})
  --rounds <n>          bursts per level; more rounds, steadier refusal rate
                        (default: ${DEFAULT_ROUNDS})
  --upload-id <uuid>    reuse an already-staged upload and skip staging entirely
  --no-project          send no projectId: validation stops after the geometry
                        checks, no project pool is needed, and the worker pool
                        and parse budget are isolated from the database
  --settle-ms <n>       quiet time between levels (default: ${DEFAULT_SETTLE_MS}).
                        A level that was refused waits its Retry-After on top.
  --timeout-ms <n>      per-request timeout (default: ${DEFAULT_REQUEST_TIMEOUT_MS})
  --stop-rate <0..1>    stop climbing once this share of a burst is refused
                        (default: ${DEFAULT_STOP_RATE}); --no-early-stop to climb anyway
  --expect-clear-to <n> exit non-zero unless the service is clear to n
                        concurrent. This is what makes the probe a regression
                        guard rather than a measurement.
  --json <path>         also write the full report as JSON
  --help

Environment
  API_BASE_URL          backend base URL (default: http://localhost:3001)
  BEARER_TOKEN          a Defra ID token; minted from the stub when unset
  CDP_UPLOADER_URL      uploader base URL (default: http://localhost:7337)
  UPLOAD_S3_BUCKET      bucket the staged file lands in (default: baseline-files)
`

function readArgs(argv) {
  const options = {
    size: DEFAULT_SIZE,
    ladder: DEFAULT_LADDER,
    rounds: DEFAULT_ROUNDS,
    uploadId: null,
    withProject: true,
    settleMs: DEFAULT_SETTLE_MS,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    stopRate: DEFAULT_STOP_RATE,
    earlyStop: true,
    expectClearTo: null,
    json: null,
    help: false
  }
  const takesValue = {
    '--size': (v) => ({ size: v }),
    '--ladder': (v) => ({ ladder: v }),
    '--rounds': (v) => ({ rounds: Number(v) }),
    '--upload-id': (v) => ({ uploadId: v }),
    '--settle-ms': (v) => ({ settleMs: Number(v) }),
    '--timeout-ms': (v) => ({ timeoutMs: Number(v) }),
    '--stop-rate': (v) => ({ stopRate: Number(v) }),
    '--expect-clear-to': (v) => ({ expectClearTo: Number(v) }),
    '--json': (v) => ({ json: v })
  }
  const flags = {
    '--no-project': { withProject: false },
    '--no-early-stop': { earlyStop: false },
    '--help': { help: true },
    '-h': { help: true }
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (flags[arg]) {
      Object.assign(options, flags[arg])
    } else if (takesValue[arg]) {
      i += 1
      if (i >= argv.length) {
        throw new Error(`${arg} needs a value`)
      }
      Object.assign(options, takesValue[arg](argv[i]))
    } else {
      throw new Error(`unknown option "${arg}" — run with --help`)
    }
  }
  return options
}

function readEnv() {
  return {
    apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3001',
    uploaderUrl: process.env.CDP_UPLOADER_URL || 'http://localhost:7337',
    bucket: process.env.UPLOAD_S3_BUCKET || 'baseline-files',
    fixturesDir: process.env.FIXTURES_DIR || join(ROOT_DIR, 'fixtures'),
    readyTimeoutMs: Number(
      process.env.UPLOAD_READY_TIMEOUT_MS || DEFAULT_UPLOAD_READY_TIMEOUT_MS
    )
  }
}

/**
 * A token, minted from the cdp-defra-id-stub when the environment has not
 * supplied one. Spawned rather than imported because get-stub-token.mjs is a
 * script that writes the token to stdout — the same contract entrypoint.sh
 * consumes it through, so there is one way of minting rather than two.
 */
function resolveToken() {
  if (process.env.BEARER_TOKEN) {
    return process.env.BEARER_TOKEN
  }
  note('▸ no BEARER_TOKEN — minting one from the cdp-defra-id-stub')
  return execFileSync('node', [join(SCRIPTS_DIR, 'get-stub-token.mjs')], {
    encoding: 'utf8',
    // stderr inherited so the minter's own progress and failures are visible.
    stdio: ['ignore', 'pipe', 'inherit']
  }).trim()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeClient({ apiBaseUrl, token }) {
  const headers = (extra = {}) => ({
    authorization: `Bearer ${token}`,
    ...extra
  })
  const request = async (method, path, body) => {
    const res = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: body ? headers({ 'content-type': 'application/json' }) : headers(),
      body: body ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    if (res.status >= HTTP_BAD_REQUEST) {
      throw new Error(
        `${method} ${path} -> ${res.status}: ${text.slice(0, ERROR_SNIPPET_MAX)}`
      )
    }
    return text ? JSON.parse(text) : null
  }
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body)
  }
}

/** The committed fixture for a size label, from fixtures/manifest.json. */
function fixtureFor(label, fixturesDir) {
  const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json')))
  const entry = manifest.sizes?.find((size) => size.label === label)
  if (!entry) {
    const known = (manifest.sizes ?? []).map((size) => size.label).join(', ')
    throw new Error(`no committed fixture called "${label}" — have: ${known}`)
  }
  return { ...entry, path: join(fixturesDir, entry.file) }
}

/**
 * Upload one fixture and wait for the virus scan, so the burst below has an
 * uploadId to aim at. Deliberately outside anything the probe measures: this is
 * the uploader's cost, not the service's.
 */
async function stageUpload({ client, fixture, env }) {
  note(
    `▸ staging ${fixture.label}: ${fixture.parcels} parcels, ` +
      `${Math.round(fixture.bytes / BYTES_PER_KB)} KB`
  )
  const { uploadId, uploadUrl } = await client.post('/upload/initiate', {
    redirect: '/done',
    s3Bucket: env.bucket,
    s3Path: 'baseline/'
  })
  const fullUrl = uploadUrl.startsWith('http')
    ? uploadUrl
    : `${env.uploaderUrl}${uploadUrl}`
  const form = new FormData()
  form.append(
    'file',
    new Blob([readFileSync(fixture.path)], {
      type: 'application/geopackage+sqlite3'
    }),
    'baseline.gpkg'
  )
  const res = await fetch(fullUrl, { method: 'POST', body: form, redirect: 'manual' })
  if (res.status >= HTTP_BAD_REQUEST) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `upload to ${fullUrl} -> ${res.status}: ${body.slice(0, ERROR_SNIPPET_MAX)}`
    )
  }
  await waitForReady({ client, uploadId, timeoutMs: env.readyTimeoutMs })
  note(`  ready: ${uploadId}`)
  return uploadId
}

async function waitForReady({ client, uploadId, timeoutMs }) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await client.get(`/upload/${uploadId}/status`)
    if (last?.uploadStatus === 'ready') {
      if (last.numberOfRejectedFiles > 0) {
        throw new Error(`upload ${uploadId} was rejected by the uploader`)
      }
      return
    }
    if (last?.uploadStatus === 'rejected') {
      throw new Error(`upload ${uploadId} rejected by the uploader`)
    }
    await sleep(UPLOAD_POLL_INTERVAL_MS)
  }
  throw new Error(`upload ${uploadId} never became ready within ${timeoutMs}ms`)
}

/**
 * Enough projects that the widest step in the ladder can give every concurrent
 * request its own. Tops the owner's existing projects up rather than creating a
 * fresh set, so repeated runs do not pile rows up.
 */
async function ensureProjects({ client, needed }) {
  const existing = await client.get('/projects')
  const owned = Array.isArray(existing) ? existing : (existing?.projects ?? [])
  const ids = owned.map((project) => project.id).filter(Boolean)
  const had = ids.length
  while (ids.length < needed) {
    const created = await client.post('/projects/new', {
      project: { name: `saturation probe ${ids.length + 1}` }
    })
    ids.push(created.id)
  }
  note(`▸ project pool: ${had} existing, ${ids.length} available, ${needed} needed`)
  return ids.slice(0, needed)
}

/**
 * One validate call, which never throws: a burst is only interpretable if every
 * request in it produces a row, and a transport failure is a row too.
 */
async function validateOnce({ apiBaseUrl, token, uploadId, projectId, timeoutMs }) {
  const startedAt = performance.now()
  try {
    const res = await fetch(`${apiBaseUrl}/baseline/validate/${uploadId}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(projectId ? { projectId } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await res.text()
    const endedAt = performance.now()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    const retryAfter = Number(res.headers.get('retry-after'))
    return {
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      status: res.status,
      outcome: classifyResponse({ status: res.status, body }),
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
      detail: res.status === HTTP_OK ? null : text.slice(0, ERROR_SNIPPET_MAX)
    }
  } catch (error) {
    const endedAt = performance.now()
    return {
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      status: 0,
      outcome: OUTCOME.error,
      retryAfterSeconds: null,
      detail: error.message
    }
  }
}

/**
 * One rung: `users` requests fired at the same moment, `rounds` times over.
 *
 * Every promise is created BEFORE any of them is awaited — that is what makes
 * the burst a burst. The rounds are sequential, because two overlapping rounds
 * would put more than `users` in flight and the rung would stop meaning what
 * its label says.
 */
async function runStep({ users, rounds, projectIds, ...call }) {
  const results = []
  for (let round = 0; round < rounds; round += 1) {
    const inFlight = Array.from({ length: users }, (_, index) =>
      validateOnce({ ...call, projectId: projectIds?.[index] ?? null })
    )
    results.push(...(await Promise.all(inFlight)))
  }
  return summariseStep({ users, results })
}

function stepLine(step) {
  const refused = `${step[OUTCOME.busy]} busy`
  const overloadedNote = step[OUTCOME.overloaded]
    ? `, ${step[OUTCOME.overloaded]} rss-limited`
    : ''
  return (
    `  ${step.users} concurrent: ${step[OUTCOME.ok]}/${step.sent} ok, ` +
    `${refused}${overloadedNote}, p95 ${Math.round(step.p95Ms)}ms, ` +
    `max in flight ${step.maxOverlap}`
  )
}

/** Quiet time before the next rung — longer if this one was actually refused. */
function settleMsAfter(step, baseMs) {
  if (step.refused === 0) {
    return baseMs
  }
  const retryAfter = step.retryAfterSeconds ?? FALLBACK_RETRY_AFTER_SECONDS
  return baseMs + retryAfter * MS_PER_SECOND
}

async function climb({ ladder, options, projectIds, call }) {
  const steps = []
  for (const users of ladder) {
    const step = await runStep({
      users,
      rounds: options.rounds,
      projectIds: projectIds?.slice(0, users) ?? null,
      ...call
    })
    steps.push(step)
    note(stepLine(step))
    if (step[OUTCOME.conflict] > 0) {
      note(
        '  ! 409s at this step: two requests shared a project. The pool is too ' +
          'small — this rung measures the row lock, not the validator.'
      )
    }
    if (options.earlyStop && step.refusedRate >= options.stopRate) {
      note(`▸ stopping the climb: ${users} concurrent is already past the knee`)
      break
    }
    await sleep(settleMsAfter(step, options.settleMs))
  }
  return steps
}

/**
 * The context a reader needs to interpret the table, and the one thing this
 * probe genuinely cannot see.
 *
 * The 503 body carries no reason — `no_capacity`, `queue_full`, `queue_wait`
 * and `memory_budget` are deliberately kept off the wire, and go to the
 * GeoPackageValidationBusy metric and a `warn` line instead. Which of the four
 * fired is the difference between "add workers" and "the files are too big for
 * the budget", so the report says where to read it rather than leaving the
 * question hanging.
 */
function contextLines({ fixture, withProject }) {
  return [
    '',
    'Reading this',
    `  Fixture: ${fixture.label} — ${fixture.parcels} parcels, ` +
      `${Math.round(fixture.bytes / BYTES_PER_KB)} KB.`,
    `  Mode: ${withProject ? 'full pipeline (validate + persist to a project)' : 'geometry only (no projectId, nothing persisted)'}.`,
    '  At the shipped defaults the admission cap is workerCount + queueLimit',
    '  = 2 + 8 = 10 in flight, and the parse budget allows',
    '  550 MiB / (2 MB + 10 x file size) — whichever is smaller binds first.',
    '  A target running non-default VALIDATION_* settings will knee elsewhere.',
    '',
    '  The 503 body does not say WHICH refusal fired. To attribute it, read the',
    '  backend log for the run:',
    '    grep "validation refused as busy" <backend log>',
    '  or the GeoPackageValidationBusy metric, sliced by `reason`',
    '  (no_capacity | queue_full | queue_wait | memory_budget).'
  ]
}

function report({ steps, knee, options, ladder, fixture }) {
  out('')
  out(formatTable(steps))
  out('')
  for (const line of verdictLines({ knee, steps, ladder, stopRate: options.stopRate })) {
    out(line)
  }
  for (const line of contextLines({ fixture, withProject: options.withProject })) {
    out(line)
  }
}

/**
 * The assertion that turns the measurement into a guard: did the service stay
 * clear up to the level we expect it to? Returns the process exit code.
 */
function checkExpectation({ knee, expectClearTo }) {
  if (expectClearTo === null) {
    return 0
  }
  const clearTo = knee.clearTo ?? 0
  if (clearTo >= expectClearTo) {
    out(`\nPASS: clear to ${clearTo} concurrent, expected at least ${expectClearTo}.`)
    return 0
  }
  out(
    `\nFAIL: clear to only ${clearTo} concurrent, expected at least ` +
      `${expectClearTo}. The service is shedding load earlier than it used to.`
  )
  return 1
}

async function main() {
  const options = readArgs(process.argv.slice(2))
  if (options.help) {
    out(USAGE.trim())
    return 0
  }
  const ladder = parseLadder(options.ladder)
  const env = readEnv()
  const fixture = fixtureFor(options.size, env.fixturesDir)
  const token = resolveToken()
  const client = makeClient({ apiBaseUrl: env.apiBaseUrl, token })

  note(`▸ target: ${env.apiBaseUrl}`)
  const uploadId =
    options.uploadId ?? (await stageUpload({ client, fixture, env }))

  // Only the full-pipeline mode needs projects, and only as many as the widest
  // rung — creating the whole pool for a --no-project run would be setup cost
  // for something the run never sends.
  const projectIds = options.withProject
    ? await ensureProjects({ client, needed: ladder.at(-1) })
    : null

  note(
    `▸ climbing ${ladder.join(', ')} at ${options.rounds} round(s) each ` +
      `against upload ${uploadId}`
  )
  const steps = await climb({
    ladder,
    options,
    projectIds,
    call: {
      apiBaseUrl: env.apiBaseUrl,
      token,
      uploadId,
      timeoutMs: options.timeoutMs
    }
  })

  const knee = findKnee(steps, { stopRate: options.stopRate })
  report({ steps, knee, options, ladder, fixture })
  if (options.json) {
    writeFileSync(
      options.json,
      `${JSON.stringify({ target: env.apiBaseUrl, fixture, uploadId, options, ladder, steps, knee }, null, 2)}\n`
    )
    note(`▸ wrote ${options.json}`)
  }
  return checkExpectation({ knee, expectClearTo: options.expectClearTo })
}

// Only probe when RUN as a script. The pure helpers above are unit-tested, and
// importing this module to reach them must not start firing bursts at a server.
if (process.argv[1]?.endsWith('saturation-probe.mjs')) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      note(`saturation-probe failed: ${err.message}`)
      process.exit(1)
    })
}
