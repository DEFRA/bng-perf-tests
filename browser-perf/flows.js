// Page flows reproduced from the journey-tests' verified page objects (that repo
// is not imported — everything the perf test needs lives here). If the hosted
// Defra ID pages or the app's routes change, re-confirm these selectors with a
// headed run against dev, exactly as the journey-tests' page objects warn.
import { expect } from '@playwright/test'

const LOGIN_TIMEOUT_MS = 60_000
// cdp-uploader's virus scan + the backend's waitForUploadReady, then the O(N^2)
// validate itself — generous so a large, unfixed (slow) validate still completes
// and is measured rather than timing out.
const RECEIVED_TIMEOUT_MS = 180_000

// Real Defra ID (Government Gateway) sign-in — the same six steps the journey
// tests drive in e2e mode (test/pages/defra-id-login.page.js). The test account
// has no MFA, so this is fully scriptable.
export async function login(page, username, password) {
  await page.goto('/auth/login', { waitUntil: 'domcontentloaded' })
  await page
    .getByRole('radio', { name: 'Sign in with Government Gateway' })
    .check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel('Government Gateway user ID').fill(username)
  // exact: true — the GOV.UK password field has a "Show password" toggle whose
  // accessible name also contains "password".
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Back on the app: dashboard, or the create-first-project page for a completer
  // with no projects yet. Either means we're authenticated.
  await page.waitForURL(/\/manage-projects|\/project-name/, {
    timeout: LOGIN_TIMEOUT_MS,
    waitUntil: 'domcontentloaded'
  })
}

// Create a project and return its id, parsed from the task-list URL
// (/add-project-details/{id}) the app lands on after "Save and continue".
export async function createProject(page, name) {
  await page.goto('/manage-projects')
  // With no projects, /manage-projects redirects straight to /project-name —
  // only click "Create project" when the button is actually present.
  if (!page.url().includes('/project-name')) {
    await page.getByRole('button', { name: 'Create project' }).click()
  }
  const nameInput = page.getByRole('textbox')
  // The name field caps length client-side; drop it so a long perf label fits.
  await nameInput.evaluate((el) => el.removeAttribute('maxlength'))
  await nameInput.fill(name)
  await page.getByRole('button', { name: 'Save and continue' }).click()

  await page.waitForURL(/\/add-project-details\/[0-9a-f-]+/i, {
    timeout: LOGIN_TIMEOUT_MS
  })
  const match = page.url().match(/\/add-project-details\/([0-9a-f-]+)/i)
  if (!match) {
    throw new Error(`Could not parse projectId from URL: ${page.url()}`)
  }
  return match[1]
}

// Upload a baseline GeoPackage and time the validation step.
//
// Clicking "Continue" posts the file to cdp-uploader, which redirects the browser
// to /projects/{id}/upload-received — and THAT handler is where the frontend calls
// the backend's /baseline/validate server-side. So the received request's
// time-to-first-byte (responseStart - requestStart) is the server-side cost of
// waitForUploadReady + validate, with the browser<->uploader file-transfer time
// excluded. validate is the only O(N^2) term, so this is the BMD-911 signal;
// waitForUploadReady adds a roughly size-independent offset that the N-vs-2N ratio
// divides out.
export async function uploadBaselineAndTime(page, projectId, fixturePath) {
  await page.goto(`/projects/${projectId}/upload-baseline-file`)
  // setInputFiles targets the real hidden input even though the GOV.UK enhanced
  // upload shows a button in its place.
  await page.locator('input[type="file"]').setInputFiles(fixturePath)

  const receivedResponsePromise = page.waitForResponse(
    (r) =>
      r.url().includes('/upload-received') && r.request().method() === 'GET',
    { timeout: RECEIVED_TIMEOUT_MS }
  )
  await page.getByRole('button', { name: 'Continue' }).click()
  const response = await receivedResponsePromise

  const timing = response.request().timing()
  const serverMs = Math.round(timing.responseStart - timing.requestStart)
  return { serverMs, status: response.status() }
}

// Sanity gate so a broken run fails with a clear reason rather than a confusing
// selector timeout deep in the flow.
export function assertCredentials(username, password) {
  expect(
    Boolean(username && password),
    'DEFRA_ID_USERNAME and DEFRA_ID_PASSWORD must be set (CDP Portal secrets) — the perf test signs in as a real no-MFA test account, the same way the journey-tests do in e2e mode.'
  ).toBe(true)
}
