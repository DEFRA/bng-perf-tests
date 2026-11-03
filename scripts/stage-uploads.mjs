/**
 * Prepare everything the upload scenarios need, before JMeter starts.
 *
 * The upload journey is four steps — initiate, POST the file to the CDP
 * Uploader, wait until it is scanned, then validate. The validate-only phases
 * isolate the service's own cost, so their uploads are staged here, in Node,
 * and JMeter is handed a set of ready `uploadId`s to hammer. (The journey
 * phases measure all four steps end-to-end — they drive their own uploads from
 * the plan and need nothing staged beyond the project pool.)
 *
 * It also creates a pool of projects. Validation only runs the full pipeline —
 * extract, size, persist — when a `projectId` is supplied; without one it stops
 * after the geometry checks and would under-measure the real cost. Concurrent
 * uploads to the *same* project serialise on a row lock and 409, so each
 * concurrent thread needs its own project.
 *
 * Output on stdout, one `key=value` per line, for entrypoint.sh to turn into
 * JMeter properties:
 *   uploadId_<label>=<uuid>
 * ONLY for the sizes that actually staged — entrypoint.sh treats a missing
 * uploadId as "skip that phase". Everything else (parcel counts, byte sizes,
 * progress, failures) goes to stderr, which is the run log rather than the
 * property channel. Plus a projects CSV written to disk for JMeter's CSV Data
 * Set.
 *
 * UPLOAD_TEMPLATE picks which upload template the run stages, and must match
 * the target service's SERVICE_TEMPLATE_ENABLED flag:
 *   legacy   (default) the Natural England baseline, plus a generated
 *            post-intervention file paired with it — for scenarios/bng-perf.jmx
 *            against a service with the flag off
 *   service  the BNG Service template: ONE file per size holding both stages,
 *            staged once and used as both uploadId_<label> and
 *            piUploadId_<label> — for scenarios/bng-perf-template.jmx against a
 *            service with the flag on. Goes when the legacy template is
 *            decommissioned (BMD-1097), and with it the legacy branch.
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  makeGeoPackage,
  makeGeoPackagePair,
  makeTemplateGeoPackage
} from './make-gpkg.mjs'

export const LEGACY_TEMPLATE = 'legacy'
export const SERVICE_TEMPLATE = 'service'

/** The plan each upload template is staged for, named in errors. */
export const PLAN_FOR_TEMPLATE = Object.freeze({
  [LEGACY_TEMPLATE]: 'scenarios/bng-perf.jmx',
  [SERVICE_TEMPLATE]: 'scenarios/bng-perf-template.jmx'
})

/**
 * Parse UPLOAD_TEMPLATE. Loud on an unknown value: staging the wrong template
 * would have every validate in the run refused at the format gate, which reads
 * in the report as a service failing rather than a mistyped setting.
 *
 * @param {string | undefined} value
 * @returns {'legacy' | 'service'}
 */
export function parseUploadTemplate(value) {
  const template = String(value || LEGACY_TEMPLATE).trim().toLowerCase()
  if (!(template in PLAN_FOR_TEMPLATE)) {
    throw new Error(
      `UPLOAD_TEMPLATE must be one of ${Object.keys(PLAN_FOR_TEMPLATE).join(', ')} (got: ${value})`
    )
  }
  return template
}

const API_BASE_URL = process.env.API_BASE_URL
const BEARER_TOKEN = process.env.BEARER_TOKEN
const CDP_UPLOADER_URL = process.env.CDP_UPLOADER_URL
// `||`, not `??`, throughout: entrypoint.sh passes every one of these on the
// command line whether or not the operator set it, so an unset variable arrives
// as an empty string rather than as undefined. `??` treats that as a deliberate
// value and the defaults below never apply — an empty UPLOAD_READY_TIMEOUT_MS
// becomes a 0 ms deadline, an empty PROJECT_POOL_SIZE a pool of none. This is
// the same guard seed-via-api.mjs's `positiveIntEnv` applies for the same reason.
const STAGE_DIR = process.env.STAGE_DIR || '/opt/perftest/stage'
const FIXTURES_DIR =
  process.env.FIXTURES_DIR || join(import.meta.dirname, '..', 'fixtures')
const PROJECTS_CSV = process.env.PROJECTS_CSV || join(STAGE_DIR, 'projects.csv')
const S3_BUCKET = process.env.UPLOAD_S3_BUCKET || 'baseline-files'

const UPLOAD_READY_TIMEOUT_MS = Number(
  process.env.UPLOAD_READY_TIMEOUT_MS || 180_000
)
const UPLOAD_POLL_INTERVAL_MS = 1000
const PROJECT_POOL_SIZE = Number(process.env.PROJECT_POOL_SIZE || 40)

/**
 * Which sizes need a PREPARED pool, and how big, as `label:count` pairs.
 *
 * A prepared project is one that already holds a validated baseline — which the
 * edit, post-intervention and fetch groups all need and the plain pool cannot
 * give them: an empty project has no feature to edit, no document worth
 * fetching, and no baseline for a post-intervention upload to reconcile against.
 *
 * entrypoint.sh computes this from the ACTIVE PROFILE's own thread counts, so a
 * run prepares exactly the pools it is going to use. Preparing a `large` pool
 * costs a validate of a 4 MB file per project, which is real setup time to
 * spend on a ladder the profile is not running.
 */
const PREPARED_SIZES = process.env.PREPARED_SIZES || ''

/** Sizes needing a staged post-intervention upload, as a comma-separated list. */
const PI_SIZES = process.env.PI_SIZES || ''

/**
 * How many features of ONE project the contention ladder gets to choose from.
 *
 * Each thread edits a different feature of the same project, which is the real
 * scenario the project-row lock serialises — two people editing two habitats in
 * one project. Fewer features than threads is fine (the CSV recycles); the pool
 * only has to be wide enough that threads are not all queueing on one row.
 */
const CONTENTION_FEATURES = Number(process.env.CONTENTION_FEATURES || 20)

const HTTP_BAD_REQUEST = 400

/**
 * The file sizes the run profiles, as `label:parcels` pairs.
 *
 * The defaults bracket reality deliberately. Real BNG files in the reference
 * corpus top out around 80 parcels / 124 KB, so `normal` is what a user
 * actually submits; the larger steps are there to find where the service stops
 * coping, not because anyone uploads them today.
 *
 * The top of the ramp is 12 000 parcels / ~9 MB. Bigger than that is not a size
 * the service will ever be asked to handle — it is already two orders of
 * magnitude past the real corpus — and it costs disproportionately to stage,
 * because bng-library's `partitionPolygon` re-sorts the whole parcel list on
 * every split: generation is roughly quadratic, so 5 000 parcels takes ~1.6 s
 * and 12 000 takes ~9 s.
 */
const DEFAULT_SIZES = 'normal:80,medium:800,large:5000,xlarge:12000'

/**
 * The size labels the JMeter plan is wired to.
 *
 * Both plans (`scenarios/bng-perf.jmx`, `scenarios/bng-perf-template.jmx`)
 * read `uploadId_normal` / `_medium` / `_large` /
 * `_xlarge` by name, one hard-coded sampler each, and every concurrency phase
 * reads `uploadId_large`. So UPLOAD_SIZES sets how big each step is — that is
 * what it is for — but not what the steps are called. A label the plan does not
 * know stages a file nothing ever validates; a label the plan expects and does
 * not get leaves a phase POSTing to `/baseline/validate/` with an empty path
 * segment. Neither shows up as anything but bad numbers in the report, so both
 * are rejected here, before a run is spent on them.
 */
const PLAN_SIZE_LABELS = ['normal', 'medium', 'large', 'xlarge']

/**
 * Labels become `-JuploadId_<label>=` arguments, and entrypoint.sh deliberately
 * leaves that string unquoted so it word-splits into separate arguments — so a
 * label containing whitespace would split one argument into two.
 */
const LABEL_PATTERN = /^[a-z][a-z0-9_]*$/

/** `count` indexes, `0 .. count - 1`. */
function steps(count) {
  return Array.from({ length: count }, (_, index) => index)
}

/**
 * Yield `items` one at a time, for `for await`.
 *
 * Every await in this file's loops is sequential on purpose: staging is setup,
 * and running those requests together would be the burst the run exists to
 * measure, taken before the measurement starts.
 */
async function* sequentially(items) {
  for (const item of items) {
    yield item
  }
}

/** One timestamp per check, until `deadlineMs`. A poll waits between checks. */
async function* until(deadlineMs) {
  while (Date.now() < deadlineMs) {
    yield Date.now()
  }
}

function parseSizes(spec) {
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [label, parcels] = entry.split(':')
      const size = { label: (label ?? '').trim(), parcels: Number(parcels) }
      // Loud, not lenient: a dropped entry used to leave a phase with no upload
      // and no explanation anywhere.
      if (!LABEL_PATTERN.test(size.label)) {
        throw new Error(
          `bad label in UPLOAD_SIZES entry "${entry}" — labels must match ${LABEL_PATTERN}`
        )
      }
      if (!Number.isFinite(size.parcels) || size.parcels <= 0) {
        throw new Error(
          `bad parcel count in UPLOAD_SIZES entry "${entry}" — expected <label>:<positive integer>`
        )
      }
      return size
    })
}

/** Reject a size spec the plan cannot consume, naming the fix. */
function assertPlanLabels(sizes, template) {
  const got = sizes.map((s) => s.label)
  const missing = PLAN_SIZE_LABELS.filter((label) => !got.includes(label))
  const unknown = got.filter((label) => !PLAN_SIZE_LABELS.includes(label))
  if (missing.length === 0 && unknown.length === 0) {
    return
  }
  const detail = [
    missing.length ? `missing: ${missing.join(', ')}` : '',
    unknown.length ? `not in the plan: ${unknown.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('; ')
  throw new Error(
    `UPLOAD_SIZES must name exactly the labels ${PLAN_FOR_TEMPLATE[template]} reads ` +
      `(${PLAN_SIZE_LABELS.join(', ')}) — ${detail}. Change the parcel counts, not the labels.`
  )
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${BEARER_TOKEN}`, ...extra }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (res.status >= HTTP_BAD_REQUEST) {
    // The body rides on the error so a caller can read a refusal the service
    // expressed as a 4xx — the preflight does, to name the flag rather than
    // report a bare status. A body that is not JSON parses as null.
    const error = new Error(`POST ${url} -> ${res.status}: ${text.slice(0, 300)}`)
    error.status = res.status
    try {
      error.body = text ? JSON.parse(text) : null
    } catch {
      error.body = null
    }
    throw error
  }
  return text ? JSON.parse(text) : null
}

async function getJson(url) {
  const res = await fetch(url, { headers: authHeaders() })
  const text = await res.text()
  if (res.status >= HTTP_BAD_REQUEST) {
    throw new Error(`GET ${url} -> ${res.status}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : null
}

/** Ask the backend for an upload slot. Returns the uploader path to POST to. */
async function initiateUpload() {
  return postJson(`${API_BASE_URL}/upload/initiate`, {
    redirect: '/done',
    s3Bucket: S3_BUCKET,
    s3Path: 'baseline/'
  })
}

/**
 * POST the file to the CDP Uploader. The backend hands back only the *path*
 * (it strips the host), so the uploader's own base URL has to be supplied.
 */
async function postFileToUploader(uploadUrl, filePath, bytes) {
  const fullUrl = uploadUrl.startsWith('http')
    ? uploadUrl
    : `${CDP_UPLOADER_URL}${uploadUrl}`

  const { readFile } = await import('node:fs/promises')
  const fileBytes = await readFile(filePath)
  const form = new FormData()
  form.append(
    'file',
    new Blob([fileBytes], { type: 'application/geopackage+sqlite3' }),
    'baseline.gpkg'
  )

  const res = await fetch(fullUrl, {
    method: 'POST',
    body: form,
    redirect: 'manual'
  })
  // The uploader answers a successful upload with a 302 to the redirect target.
  if (res.status >= HTTP_BAD_REQUEST) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `upload of ${(bytes / 1024).toFixed(0)}KB to ${fullUrl} -> ${res.status}: ${body.slice(0, 300)}`
    )
  }
}

/**
 * Wait for the uploader to finish scanning. Large files take noticeably longer
 * here than small ones — this is the uploader's virus scan, not our service, so
 * it is deliberately outside what the run measures.
 */
async function waitForReady(uploadId) {
  const deadline = Date.now() + UPLOAD_READY_TIMEOUT_MS
  let last
  for await (const now of until(deadline)) {
    last = await getJson(`${API_BASE_URL}/upload/${uploadId}/status`)
    if (last?.uploadStatus === 'ready') {
      if (last.numberOfRejectedFiles > 0) {
        throw new Error(
          `upload ${uploadId} was rejected by the uploader: ${JSON.stringify(last).slice(0, 300)}`
        )
      }
      return last
    }
    if (last?.uploadStatus === 'rejected') {
      throw new Error(`upload ${uploadId} rejected: ${JSON.stringify(last).slice(0, 300)}`)
    }
    const remaining = deadline - now
    if (remaining <= 0) {
      break
    }
    await new Promise((r) =>
      setTimeout(r, Math.min(UPLOAD_POLL_INTERVAL_MS, remaining))
    )
  }
  throw new Error(
    `upload ${uploadId} never became ready within ${UPLOAD_READY_TIMEOUT_MS}ms (last: ${JSON.stringify(last)})`
  )
}

/**
 * An error message with its `cause`. Node's fetch reports every network
 * failure as a bare "fetch failed" and keeps the reason (a reset socket, a
 * refused connection) on `cause`, so without it the log cannot say which.
 */
export function describeError(err) {
  const cause = err?.cause
  if (!cause) {
    return err?.message ?? String(err)
  }
  const detail = [cause.code, cause.message].filter(Boolean).join(' ')
  return `${err.message} (${detail || String(cause)})`
}

/**
 * True for a fetch that never got a response, as opposed to one the service
 * answered with an error status — only the first is worth retrying.
 */
export function isNetworkError(err) {
  return err instanceof TypeError && err.message === 'fetch failed'
}

/**
 * Initiate, upload and wait for the scan, retrying once on a network error.
 *
 * Generating a large file blocks the event loop for seconds, long enough for
 * the server to close fetch's idle keep-alive socket without fetch noticing;
 * the next request then goes out on the dead socket and fails. A second
 * attempt opens a fresh connection. Each attempt initiates its own upload, so
 * a half-finished first attempt cannot leak into the second.
 */
async function uploadAndWait(filePath, bytes) {
  try {
    return await uploadOnce(filePath, bytes)
  } catch (err) {
    if (!isNetworkError(err)) {
      throw err
    }
    process.stderr.write(`  retrying after a network error: ${describeError(err)}\n`)
    return uploadOnce(filePath, bytes)
  }
}

async function uploadOnce(filePath, bytes) {
  const { uploadId, uploadUrl } = await initiateUpload()
  await postFileToUploader(uploadUrl, filePath, bytes)
  await waitForReady(uploadId)
  return uploadId
}

/**
 * The manifest entry for a size, when there is one. fixtures/manifest.json
 * (written by gen-fixtures.mjs) is matched on template, label AND parcel
 * count, so a UPLOAD_SIZES override that changes a count simply falls back to
 * generating — the fast path never uploads a file of the wrong size, or the
 * wrong template, under the right name. An entry with no `template` predates
 * the BNG Service set and is legacy.
 *
 * @param {{ sizes?: object[] } | null | undefined} manifest
 * @param {{ template: string, label: string, parcels: number }} size
 */
export function manifestEntry(manifest, { template, label, parcels }) {
  return (
    manifest?.sizes?.find(
      (s) =>
        (s.template ?? LEGACY_TEMPLATE) === template &&
        s.label === label &&
        s.parcels === parcels
    ) ?? null
  )
}

function committedFixture(size) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json')))
  } catch {
    return null
  }
  const entry = manifestEntry(manifest, size)
  return entry ? { path: join(FIXTURES_DIR, entry.file), bytes: entry.bytes } : null
}

async function stageOneSize({ template, label, parcels }) {
  const fixture = committedFixture({ template, label, parcels })
  let filePath
  let bytes
  if (fixture) {
    ;({ path: filePath, bytes } = fixture)
    process.stderr.write(
      `▸ ${label}: ${parcels} parcels, ${(bytes / 1024).toFixed(0)} KB ` +
        `(committed fixture) — uploading\n`
    )
  } else {
    const service = template === SERVICE_TEMPLATE
    filePath = join(STAGE_DIR, `${service ? 'template' : 'baseline'}-${label}.gpkg`)
    let generationMs
    ;({ bytes, generationMs } = (
      service ? makeTemplateGeoPackage : makeGeoPackage
    )(filePath, parcels))
    // Generation time is logged because it is super-linear in parcel count and
    // is pure setup cost — a task that looks slow to start is usually the top
    // of the size ramp being built, not the service being slow.
    process.stderr.write(
      `▸ ${label}: ${parcels} parcels, ${(bytes / 1024).toFixed(0)} KB ` +
        `(generated in ${(generationMs / 1000).toFixed(1)}s) — uploading\n`
    )
  }

  try {
    const uploadId = await uploadAndWait(filePath, bytes)
    process.stderr.write(`  ready: ${uploadId}\n`)
    // `template` has to travel with the upload. The prepared pools and the
    // post-intervention ladder decide their endpoint and their file from it,
    // and a size that lost it is staged as legacy — a template run then
    // measures a legacy pair the flag-on service refuses.
    return stagedSize({ template, label, parcels, bytes, uploadId })
  } finally {
    // A generated file has served its purpose either way — on success the
    // bytes now live in S3, and on failure a 9 MB scratch file has no reason
    // to sit in the container for the rest of the run. Committed fixtures are
    // repo files and stay put.
    if (!fixture) {
      rmSync(filePath, { force: true })
    }
  }
}

/**
 * Parse `label:count` pairs, e.g. `normal:10,large:5`.
 *
 * Shares the strictness of parseSizes for the same reason: a silently dropped
 * entry leaves a phase with no pool and no explanation anywhere.
 */
export function parsePreparedSizes(spec) {
  return String(spec || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [label, count] = entry.split(':')
      const parsed = { label: (label ?? '').trim(), count: Number(count) }
      if (!LABEL_PATTERN.test(parsed.label)) {
        throw new Error(
          `bad label in PREPARED_SIZES entry "${entry}" — labels must match ${LABEL_PATTERN}`
        )
      }
      if (!Number.isInteger(parsed.count) || parsed.count <= 0) {
        throw new Error(
          `bad count in PREPARED_SIZES entry "${entry}" — expected <label>:<positive integer>`
        )
      }
      return parsed
    })
}

/**
 * The habitat features of a project that are safe to edit repeatedly.
 *
 * "Safe" means every attribute the PUT sends is already present: the edit
 * writes the feature's own values back, so a feature missing one of them would
 * send a blank, and `normalizeEdits` turns a blank into a null — which is a
 * different edit from the no-op this is meant to be, and would drift the
 * document over a run rather than measuring the same write repeatedly.
 *
 * Generated files cannot carry out-of-scope (High / V.High) distinctiveness —
 * bng-library draws from IN_SCOPE_HABITATS — so the 422 gate in
 * applyFeatureUpdate is not reachable from a fixture. The filter is about
 * completeness, not scope.
 *
 * @param {object} project the `project` document from GET /projects/{id}
 * @returns {{featureId: string, broadType: string, habitatType: string, condition: string}[]}
 */
export function editableHabitats(project) {
  const habitats = project?.baseline?.habitats ?? []
  return habitats
    .filter(
      (f) => f?.featureId && f.broadType && f.type && f.condition
    )
    .map((f) => ({
      featureId: f.featureId,
      broadType: f.broadType,
      habitatType: f.type,
      condition: f.condition
    }))
}

/**
 * CSV-quote a field.
 *
 * Habitat and condition names are free text from the reference data — "Other
 * neutral grassland", and nothing today contains a comma, but nothing stops one
 * appearing either. An unquoted comma would shift every later column by one and
 * the edit ladder would PUT a condition into the habitatType field, which reads
 * in the report as a validation failure rather than as a broken CSV. The
 * matching CSVDataSet elements set quotedData=true.
 */
function csvField(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

function writeCsv(path, rows) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, rows.map((row) => row.map(csvField).join(',')).join('\n') + '\n')
}

/**
 * Create N projects and validate the staged baseline into each of them.
 *
 * The same `uploadId` is validated into every project. That is deliberate and
 * it is what makes this affordable: the bytes are uploaded and scanned once,
 * and `/baseline/validate/{uploadId}` is not single-use — it reads the object
 * from S3 each time. Uploading N copies would multiply the slowest part of
 * staging by N for no difference in the resulting documents.
 *
 * A BNG Service template file goes in through the post-intervention endpoint,
 * the user's single-file upload, so each prepared project holds both stages —
 * a baseline to edit and fetch, and the post-intervention document a real
 * template project has. The legacy baseline goes in through its own endpoint.
 *
 * Sequential, like the rest of staging: this is setup, and running it
 * concurrently would put the burst we are about to measure onto the service
 * before the measurement starts.
 */
async function preparePool({ template, label, count, uploadId }) {
  const endpoint = validateEndpointFor(template)
  const projects = []
  for await (const i of sequentially(steps(count))) {
    const created = await postJson(`${API_BASE_URL}/projects/new`, {
      project: { name: `perf ${label} prepared ${i + 1}` }
    })
    const result = await postJson(`${API_BASE_URL}${endpoint}/${uploadId}`, {
      projectId: created.id
    })
    if (!result?.valid) {
      throw new Error(
        `${label} did not validate into ${created.id} via ${endpoint}: ${JSON.stringify(result).slice(0, 300)}`
      )
    }
    projects.push(created.id)
  }
  return projects
}

/**
 * Turn prepared projects into the CSV row set the edit, post-intervention and
 * mixed groups read.
 *
 * One row per project, because those groups need each concurrent thread on a
 * DIFFERENT project — validation and editing both serialise on the project row
 * lock, so two threads sharing a project would measure the lock rather than the
 * work. The feature is fetched per project rather than assumed shared: the
 * files are identical, but featureIds are minted at validation time and differ
 * between projects.
 */
async function preparedRows(projectIds) {
  const rows = []
  for await (const projectId of projectIds) {
    const project = await getJson(`${API_BASE_URL}/projects/${projectId}`)
    const [feature] = editableHabitats(project?.project)
    if (!feature) {
      process.stderr.write(
        `  ! ${projectId} has no fully-attributed habitat to edit — excluded from the pool\n`
      )
      continue
    }
    rows.push([
      projectId,
      feature.featureId,
      feature.broadType,
      feature.habitatType,
      feature.condition
    ])
  }
  return rows
}

/**
 * Stage the post-intervention half of the pair.
 *
 * `deriveBaselineFromSynthetic` produces the baseline BY CLEARING the proposed
 * columns of a synthetic file, so regenerating the pair at the same seed
 * reproduces both halves — the baseline half byte-identical to the committed
 * fixture already staged, and the post-intervention half sharing its redline
 * and every feature ref. That shared-ref property is the whole point: the
 * backend reconciles a post-intervention upload against the stored baseline,
 * and an independently generated file would reconcile against nothing.
 */
async function stagePostIntervention({ label, parcels }) {
  const baselinePath = join(STAGE_DIR, `pair-baseline-${label}.gpkg`)
  const piPath = join(STAGE_DIR, `post-intervention-${label}.gpkg`)
  const { postIntervention } = makeGeoPackagePair(baselinePath, piPath, parcels)
  process.stderr.write(
    `▸ ${label} post-intervention: ${parcels} parcels, ` +
      `${(postIntervention.bytes / 1024).toFixed(0)} KB ` +
      `(generated in ${(postIntervention.generationMs / 1000).toFixed(1)}s) — uploading\n`
  )
  try {
    const uploadId = await uploadAndWait(piPath, postIntervention.bytes)
    process.stderr.write(`  ready: ${uploadId}\n`)
    return uploadId
  } finally {
    // The baseline half was only ever needed to derive the other one — the
    // committed fixture is what actually got staged — and neither has any
    // reason to sit in the container for the rest of the run.
    rmSync(baselinePath, { force: true })
    rmSync(piPath, { force: true })
  }
}

/**
 * A staged size, with the template it was staged as kept on it.
 *
 * @param {{ template: string, label: string, parcels: number, bytes: number, uploadId: string }} size
 */
export function stagedSize(size) {
  return {
    template: size.template,
    label: size.label,
    parcels: size.parcels,
    bytes: size.bytes,
    uploadId: size.uploadId
  }
}

/**
 * The upload the post-intervention ladder should replay, or null when the
 * run has to stage a paired legacy file.
 *
 * A BNG Service template file already holds the post-intervention stage, so
 * the upload staged for the size is the one. A legacy size, and a size whose
 * template was never recorded, needs the pair.
 *
 * @param {{ template?: string, uploadId?: string }} size
 * @returns {string | null}
 */
export function stagedPostInterventionUploadId(size) {
  return size?.template === SERVICE_TEMPLATE ? size.uploadId : null
}

/**
 * The endpoint that loads a whole upload into a project: the baseline one for
 * a legacy baseline, the post-intervention one for a BNG Service template file
 * (which stores both of its stages from there).
 *
 * @param {string} template
 */
export function validateEndpointFor(template) {
  return template === SERVICE_TEMPLATE
    ? '/post-intervention/validate'
    : '/baseline/validate'
}

/**
 * Explain a preflight validate the format gate refused, naming the likely fix.
 *
 * Neither template is accepted by a service set for the other, and nothing
 * auto-detects the format: the flag alone decides. So an upload refused at the
 * gate almost always means the run's UPLOAD_TEMPLATE does not match the target
 * backend's SERVICE_TEMPLATE_ENABLED — and every validate in the plan would be
 * refused the same way. Null when the result is a pass.
 *
 * @param {string} template the run's UPLOAD_TEMPLATE
 * @param {{ valid?: boolean, errors?: { code?: string }[] } | null} result
 * @returns {string | null}
 */
export function formatMismatchMessage(template, result) {
  if (result?.valid) {
    return null
  }
  const codes = [
    ...new Set((result?.errors ?? []).map((e) => e?.code).filter(Boolean))
  ]
  const expected = template === SERVICE_TEMPLATE ? 'true' : 'false'
  return (
    `the staged ${template} upload did not validate (${codes.join(', ') || 'no error code'}). ` +
    `A ${template} run needs the target backend's SERVICE_TEMPLATE_ENABLED=${expected}; ` +
    `check the flag on the environment, or set UPLOAD_TEMPLATE to match it.`
  )
}

/**
 * What a preflight says when the validate call threw.
 *
 * A 4xx is the service refusing the file, and the format gate refuses with an
 * error status rather than a 200, so the verdict is in the body and naming the
 * flag is the whole point. A body that did not parse (`err.body` null) still
 * names the flag, only without an error code. A 5xx or a network error is not a
 * format verdict and stays a plain preflight failure.
 *
 * @param {string} template the run's UPLOAD_TEMPLATE
 * @param {string} endpoint the validate path the preflight called
 * @param {string} label the size that was preflighted
 * @param {{ status?: number, body?: { valid?: boolean, errors?: object[] } | null, message?: string }} err
 * @returns {string}
 */
export function preflightFailureMessage(template, endpoint, label, err) {
  const mismatch =
    err.status >= HTTP_BAD_REQUEST && err.status < 500
      ? formatMismatchMessage(template, err.body)
      : null
  return mismatch
    ? `${mismatch} (${describeError(err)})`
    : `preflight ${endpoint} of ${label} failed: ${describeError(err)}`
}

/**
 * Validate the first staged upload once, without a project, before anything
 * is built on it. Cheap — it is the smallest size — and it is the one check
 * that catches the run and the service disagreeing about the template, which
 * would otherwise surface as a plan full of refused validates.
 */
async function preflightTemplate(template, { label, uploadId }) {
  const endpoint = validateEndpointFor(template)
  let result
  try {
    result = await postJson(`${API_BASE_URL}${endpoint}/${uploadId}`, {})
  } catch (err) {
    throw new Error(preflightFailureMessage(template, endpoint, label, err))
  }
  const mismatch = formatMismatchMessage(template, result)
  if (mismatch) {
    throw new Error(`${mismatch} (${JSON.stringify(result).slice(0, 300)})`)
  }
  process.stderr.write(
    `▸ preflight: ${label} ${template} upload validates via ${endpoint}\n`
  )
}

/**
 * Top up the owner's projects to a pool big enough that concurrent threads get
 * their own. Never deletes, so re-running a task does not pile rows up beyond
 * the target.
 */
async function ensureProjectPool() {
  const existing = await getJson(`${API_BASE_URL}/projects`)
  const owned = Array.isArray(existing) ? existing : (existing?.projects ?? [])
  const ids = owned.map((p) => p.id).filter(Boolean)

  const start = ids.length
  for await (const offset of sequentially(steps(Math.max(0, PROJECT_POOL_SIZE - start)))) {
    const created = await postJson(`${API_BASE_URL}/projects/new`, {
      project: { name: `perf upload ${start + offset + 1}` }
    })
    ids.push(created.id)
  }

  mkdirSync(dirname(PROJECTS_CSV), { recursive: true })
  writeFileSync(PROJECTS_CSV, ids.slice(0, PROJECT_POOL_SIZE).join('\n') + '\n')
  process.stderr.write(
    `▸ project pool: ${ids.length} available, wrote ${PROJECT_POOL_SIZE} to ${PROJECTS_CSV}\n`
  )
}

async function main() {
  if (!API_BASE_URL || !BEARER_TOKEN) {
    throw new Error('API_BASE_URL and BEARER_TOKEN are required')
  }
  if (!CDP_UPLOADER_URL) {
    throw new Error('CDP_UPLOADER_URL is required to POST the staged files')
  }
  mkdirSync(STAGE_DIR, { recursive: true })

  const template = parseUploadTemplate(process.env.UPLOAD_TEMPLATE)
  process.stderr.write(
    `▸ upload template: ${template} (for ${PLAN_FOR_TEMPLATE[template]})\n`
  )
  const sizes = parseSizes(process.env.UPLOAD_SIZES || DEFAULT_SIZES).map(
    (size) => ({ ...size, template })
  )
  assertPlanLabels(sizes, template)

  // Fatal on its own: every phase in the plan reads its projectId from this
  // CSV, so there is no partial run to salvage without it.
  await ensureProjectPool()

  // Sequential on purpose: staging is setup, not load. Uploading these in
  // parallel would put the very burst we are about to measure onto the service
  // before the measurement starts.
  //
  // Per-size, and not all-or-nothing: the slowest, largest fixture goes through
  // a virus scanner on someone else's schedule, and one slow scan used to cost
  // the whole task — including the home-page, project-list and project-creation
  // groups, which need no uploads at all. A size that does not stage emits no
  // uploadId, and entrypoint.sh skips the phase that would have used it.
  const staged = []
  const failed = []
  for await (const size of sizes) {
    try {
      const result = await stageOneSize(size)
      staged.push(result)
      process.stdout.write(`uploadId_${result.label}=${result.uploadId}\n`)
    } catch (err) {
      failed.push(size.label)
      process.stderr.write(`  ! ${size.label} did not stage: ${describeError(err)}\n`)
    }
  }

  if (staged.length === 0) {
    throw new Error(
      `no size staged (${failed.join(', ')}) — there is no upload load to run`
    )
  }
  // Fatal, unlike a size that did not stage: a template the service refuses
  // fails every phase, so there is nothing worth running.
  await preflightTemplate(template, staged[0])
  if (failed.length > 0) {
    process.stderr.write(
      `▸ WARNING: ${failed.length} of ${sizes.length} size(s) did not stage: ${failed.join(', ')}.\n` +
        '  Their phases will be skipped; the rest of the run continues.\n'
    )
  }

  await stagePreparedPools(staged)
}

/**
 * Build the prepared pools, the post-intervention uploads and the contention
 * project — everything the edit, fetch, post-intervention and mixed groups
 * need, and nothing the plain upload ladders do.
 *
 * Per-size and best-effort, exactly like the upload staging above: a pool that
 * cannot be built emits no property, entrypoint.sh sees the gap and skips the
 * phases that needed it, and they are ABSENT from the report rather than
 * present and wrong. A failure here never gates the run — the upload ladders,
 * which are the bulk of it, need none of this.
 */
async function stagePreparedPools(staged) {
  const wanted = parsePreparedSizes(PREPARED_SIZES)
  if (wanted.length === 0) {
    return
  }
  const stagedByLabel = new Map(staged.map((s) => [s.label, s]))
  const piWanted = new Set(
    PI_SIZES.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
  let contentionWritten = false

  for await (const { label, count } of sequentially(wanted)) {
    contentionWritten = await prepareOnePool({
      size: stagedByLabel.get(label),
      label,
      count,
      piWanted,
      contentionWritten
    })
  }
}

/**
 * One size's prepared pool, and its post-intervention upload when that size
 * needs one. A pool that cannot be built leaves the phases that needed it to
 * be skipped, and returns whether the contention pool has been written yet.
 */
async function prepareOnePool({ size, label, count, piWanted, contentionWritten }) {
  if (!size) {
    process.stderr.write(
      `  ! no staged ${label} upload — cannot prepare its pool\n`
    )
    return contentionWritten
  }
  try {
    process.stderr.write(
      `▸ preparing ${count} ${label} project(s) — validating the staged upload into each\n`
    )
    const projectIds = await preparePool({
      template: size.template,
      label,
      count,
      uploadId: size.uploadId
    })
    const rows = await preparedRows(projectIds)
    if (rows.length === 0) {
      throw new Error('no prepared project yielded an editable habitat')
    }
    const csvPath = join(STAGE_DIR, `prepared-${label}.csv`)
    writeCsv(csvPath, rows)
    process.stdout.write(`preparedCsv_${label}=${csvPath}\n`)
    // The fetch ramp wants ONE project per size — the first of the pool.
    process.stdout.write(`sizedProjectId_${label}=${rows[0][0]}\n`)
    process.stderr.write(
      `  prepared ${rows.length}/${count} ${label} project(s) → ${csvPath}\n`
    )

    // The contention ladder needs many features of ONE project, and any
    // prepared project will do. The first size to get this far provides it.
    if (!contentionWritten) {
      contentionWritten = await writeContentionPool(rows[0][0])
    }
  } catch (err) {
    process.stderr.write(
      `  ! ${label} pool did not prepare: ${describeError(err)}\n` +
        `    Its edit, fetch and post-intervention phases will be skipped.\n`
    )
    return contentionWritten
  }

  await stagePostInterventionFor({ size, label, piWanted })
  return contentionWritten
}

/** The post-intervention upload for one size, when the profile asks for it. */
async function stagePostInterventionFor({ size, label, piWanted }) {
  if (!piWanted.has(label)) {
    return
  }
  const replayed = stagedPostInterventionUploadId(size)
  if (replayed) {
    // The template file already holds the post-intervention stage, so the
    // upload staged for the size IS the post-intervention upload: one file,
    // one scan, both endpoints.
    process.stderr.write(
      `▸ ${label} post-intervention: replaying the staged template upload\n`
    )
    process.stdout.write(`piUploadId_${label}=${replayed}\n`)
    return
  }
  try {
    const uploadId = await stagePostIntervention({
      label,
      parcels: size.parcels
    })
    process.stdout.write(`piUploadId_${label}=${uploadId}\n`)
  } catch (err) {
    process.stderr.write(
      `  ! ${label} post-intervention upload did not stage: ${describeError(err)}\n`
    )
  }
}

/**
 * Write the contention ladder's feature pool: many features, ONE project.
 *
 * Every row carries the same projectId — the plan reads it from a property
 * rather than the CSV — so what the CSV supplies is the feature each thread
 * edits. Different features of one project is the real contention case:
 * `runUpdate` locks the PROJECT row, not the feature, so two people editing two
 * separate habitats still serialise on it.
 */
async function writeContentionPool(projectId) {
  const project = await getJson(`${API_BASE_URL}/projects/${projectId}`)
  const features = editableHabitats(project?.project).slice(0, CONTENTION_FEATURES)
  if (features.length === 0) {
    process.stderr.write(
      `  ! ${projectId} has no editable habitat — no contention pool\n`
    )
    return false
  }
  const csvPath = join(STAGE_DIR, 'contention.csv')
  writeCsv(
    csvPath,
    features.map((f) => [
      projectId,
      f.featureId,
      f.broadType,
      f.habitatType,
      f.condition
    ])
  )
  process.stdout.write(`contentionProjectId=${projectId}\n`)
  process.stdout.write(`contentionCsv=${csvPath}\n`)
  process.stderr.write(
    `▸ contention pool: ${features.length} feature(s) of ${projectId} → ${csvPath}\n`
  )
  return true
}

// Only stage when RUN as a script. The pure helpers above (label parsing, the
// editable-habitat filter) are worth unit-testing, and importing this module to
// reach them must not start uploading things.
if (process.argv[1]?.endsWith('stage-uploads.mjs')) {
  try {
    await main()
  } catch (err) {
    process.stderr.write(`stage-uploads failed: ${describeError(err)}\n`)
    process.exit(1)
  }
}
