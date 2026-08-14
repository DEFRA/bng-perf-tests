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

// Local stub login: drive the cdp-defra-id-stub registration flow (the journey
// tests' non-e2e path). The stub's pages are NOT the real Government Gateway
// ones, so this is only for a localhost/dev-stub target. Registers a BNG
// completer at an approved enrolment status so the upload journey is reachable.
const REL_ID = '12345'
const ORG_ID = '54321'
const ORG_NAME = 'Perf Test Org'
// Defra ID enrolment code the frontend requires: 3 = COMPLETE_APPROVED.
const ROLE_STATUS_APPROVED = '3'

export async function loginViaStub(page, { stubBaseUrl, email }) {
  // Start the app login; it redirects to the stub's authorize endpoint. Register
  // against the stub carrying that authorize URL as the post-registration return.
  await page.goto('/auth/login', { waitUntil: 'domcontentloaded' })
  const landingUrl = page.url()
  const authorizeUrl = landingUrl.includes('/register')
    ? decodeURIComponent(new URL(landingUrl).searchParams.get('redirect_uri'))
    : landingUrl
  await page.goto(
    `${stubBaseUrl}/register?redirect_uri=${encodeURIComponent(authorizeUrl)}`
  )

  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('First name').fill('BNG')
  await page.getByLabel('Last name').fill('Perf')
  await page.getByLabel('Enrolments').fill('1')
  await page.getByLabel('Enrolment Requests').fill('1')
  await page.getByRole('button', { name: 'Continue' }).click()

  await page.waitForURL(/\/relationship(?:\?|$)/)
  await page.getByLabel('Relationship ID').fill(REL_ID)
  await page.getByLabel('Organisation ID').fill(ORG_ID)
  await page.getByLabel('Organisation Name').fill(ORG_NAME)
  await page.getByRole('button', { name: 'Add relationship' }).click()

  await page.waitForURL(/\/relationship(?:\?|$)/)
  await page.getByRole('link', { name: 'Add role name & status' }).click()
  await page.waitForURL(/\/role-name/)
  await page.getByLabel('Role Name').fill('BNG completer')
  // The stub dropdown only offers word labels; inject the numeric code the
  // frontend expects and submit it directly (the stub doesn't validate it).
  await page.evaluate((status) => {
    const select = document.querySelector('#roleStatus')
    const option = document.createElement('option')
    option.value = status
    option.text = `Status ${status}`
    select.add(option)
    select.value = status
  }, ROLE_STATUS_APPROVED)
  await page.getByRole('button', { name: 'Add role' }).click()

  await page.waitForURL(/\/relationship(?:\?|$)/)
  await page.getByRole('link', { name: 'Finish' }).click()
  await page.waitForURL(/\/summary/)
  await page.getByRole('link', { name: 'Login' }).click()
  await page.waitForURL(/\/manage-projects|\/project-name/, {
    timeout: LOGIN_TIMEOUT_MS,
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
