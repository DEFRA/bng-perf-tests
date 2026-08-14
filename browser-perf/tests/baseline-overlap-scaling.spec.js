// BMD-911 — baseline validation must stop scaling quadratically with parcel count.
//
// The backend's validation query runs one un-indexed O(N^2) self-join over the
// habitat parcels (c_overlap_offending in
// backend/src/validation/geopackage/postgis/index.js), so POST /baseline/validate
// grows with the SQUARE of the parcel count. A unit/integration test can't see it:
// the endpoint returns the identical result before and after the fix — only the
// wall-clock changes, and only at scale.
//
// This runs in CDP against the REAL deployed frontend/backend. Because the browser
// can't hold a bearer token, it authenticates a real Defra ID session and drives
// the upload UI (the journey-tests' pattern), letting the frontend call
// /baseline/validate itself. It uploads the N- and 2N-parcel fixtures and times the
// server-side validation step for each (see uploadBaselineAndTime), then asserts
// the 2N/N ratio stays sub-quadratic — the shape-of-the-curve regression, which is
// machine-independent. FAILS by design against an unfixed backend; PASSES once the
// GiST index lands.
import { test, expect } from '@playwright/test'

import {
  defraIdUsername,
  defraIdPassword,
  fixtures,
  loginMode,
  scalingRatioMax,
  stubBaseUrl,
  stubUserEmail,
  validateMaxMsLarge
} from '../env.js'
import {
  login,
  loginViaStub,
  createProject,
  uploadBaselineAndTime,
  assertCredentials
} from '../flows.js'

const HTTP_OK = 200

// Real Government Gateway (perf-test/CDP) or the local cdp-defra-id-stub — same
// test either way; only the sign-in steps differ, mirroring the journey-tests.
async function authenticate(page) {
  if (loginMode === 'stub') {
    console.log('[BMD-911] login: cdp-defra-id-stub (local)')
    await loginViaStub(page, { stubBaseUrl, email: stubUserEmail })
    return
  }
  console.log('[BMD-911] login: real Defra ID (Government Gateway)')
  assertCredentials(defraIdUsername, defraIdPassword)
  await login(page, defraIdUsername, defraIdPassword)
}

test('baseline validation scales sub-quadratically with parcel count', async ({
  page
}) => {
  await authenticate(page)

  // A fresh project each run keeps the perf test independent of existing data.
  // `Date.now()` is fine here (not a workflow script) and keeps the name unique.
  const projectId = await createProject(page, `perf-overlap-${Date.now()}`)

  // Same project, uploaded twice — the second baseline overwrites the first,
  // which is exactly the supported "re-upload" path, so no second project needed.
  const small = await uploadBaselineAndTime(page, projectId, fixtures.small.path)
  const large = await uploadBaselineAndTime(page, projectId, fixtures.large.path)

  const ratio = large.serverMs / small.serverMs
  // Surfaced in the run log and the HTML report so the curve is legible even
  // when the assertion passes.
  console.log(
    `[BMD-911] validate ${fixtures.small.label}: ${small.serverMs} ms | ` +
      `${fixtures.large.label}: ${large.serverMs} ms | ratio ${ratio.toFixed(2)}x ` +
      `(quadratic ~4x, linear ~2x; gate < ${scalingRatioMax}x)`
  )

  expect(
    small.status,
    `small upload-received returned ${small.status}`
  ).toBe(HTTP_OK)
  expect(
    large.status,
    `large upload-received returned ${large.status}`
  ).toBe(HTTP_OK)

  expect(
    ratio,
    `validation cost grew ${ratio.toFixed(2)}x from ${fixtures.small.label} to ` +
      `${fixtures.large.label} — quadratic (unfixed) is ~4x, linear (fixed) ~2x`
  ).toBeLessThan(scalingRatioMax)

  if (validateMaxMsLarge > 0) {
    expect(
      large.serverMs,
      `large validate took ${large.serverMs} ms (budget ${validateMaxMsLarge} ms)`
    ).toBeLessThan(validateMaxMsLarge)
  }
})
