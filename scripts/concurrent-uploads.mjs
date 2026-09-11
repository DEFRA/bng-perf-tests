/**
 * Fire N concurrent baseline GeoPackage uploads at a running BNG Metric service
 * and watch them all happen at once, in tiled browser windows.
 *
 * This is a watch-it-happen tool, not a load generator. The JMeter plan next to
 * it is the thing that measures; this is for seeing with your own eyes what a
 * burst does to the upload journey — which windows sail through, which sit on
 * "Checking your file", and which come back busy. It shares this repo's
 * fixtures so a window uploads exactly the file a JMeter phase would.
 *
 * Three things it does that a loop of `playwright test` would not:
 *
 *  - IT SIGNS IN ONCE. The Defra ID round trip takes seconds, and hitting the
 *    real IdP N times risks tripping account lockout. One login produces a
 *    storage state every window reuses, so the burst is not gated on auth.
 *  - IT HOLDS A STARTING LINE. Every window is walked to the upload form with
 *    the file already chosen, and only then are all the Continue buttons
 *    clicked together. Staggered submissions do not reproduce a burst, and a
 *    burst is the whole point — the backend's admission control, queue depth
 *    and busy responses only engage when requests actually overlap.
 *  - IT TILES. Each window is a separate browser process given an explicit
 *    position and size, so N of them fill the screen rather than stack.
 *
 * Usage:
 *   node scripts/concurrent-uploads.mjs --url <base-url> --user <id> [options]
 *
 * Run with --help for the full option list.
 */
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures')
const MANIFEST = path.join(FIXTURES_DIR, 'manifest.json')

/** The suite's own size ladder is the natural thing to burst with. */
const DEFAULT_SIZE = 'large'
const DEFAULT_COUNT = 4

/**
 * Hard ceiling on windows.
 *
 * Each one is a separate Chromium process holding a real page, so this is a
 * limit on the machine doing the watching rather than on the service being
 * watched. Past a dozen the windows are too small to read on any ordinary
 * display, the browsers contend for CPU with each other, and the burst starts
 * measuring the laptop instead of the backend — at which point JMeter is the
 * right tool and this one is lying to you. Not a default to be raised: the
 * script refuses above it.
 */
export const MAX_WINDOWS = 12

/** Sign-in providers this knows how to drive. `auto` looks at the page. */
export const AUTH_PROVIDERS = ['auto', 'one-login', 'government-gateway']

/**
 * Budgets, in milliseconds.
 *
 * OUTCOME_TIMEOUT is deliberately longer than the frontend's own 120 s give-up
 * (MAX_WAIT_SECONDS): a window that reaches that limit shows its own "we gave
 * up" page, and seeing that page is a result worth waiting for. Anything past
 * this is the script losing track, not the service being slow.
 */
const LOGIN_TIMEOUT = 90_000

/** A human signing in by hand, MFA and all, is not in a hurry. */
const MANUAL_LOGIN_TIMEOUT = 300_000
const SETUP_TIMEOUT = 60_000
const OUTCOME_TIMEOUT = 150_000

/** macOS reserves the top of the screen for the menu bar. */
const MAC_MENU_BAR_PX = 28

/** Below this a Chromium window is too small to read anything in. */
const MIN_USABLE_WIDTH = 480
const MIN_USABLE_HEIGHT = 360

const DEFAULT_SCREEN = { width: 1920, height: 1080 }

const ansi = {
  reset: '[0m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  grey: '[90m'
}
const color = (name, text) => `${ansi[name] ?? ''}${text}${ansi.reset}`
const info = (msg) => console.log(msg)
const warn = (msg) => console.warn(color('yellow', `! ${msg}`))
const fail = (msg) => console.error(color('red', `x ${msg}`))

const HELP = `
Fire N concurrent baseline uploads at the BNG Metric service in tiled windows.

  node scripts/concurrent-uploads.mjs --url <base-url> --user <id> [options]

Required
  --url <url>          Frontend base URL, e.g.
                       https://bng-metric-frontend.dev.cdp-int.defra.cloud
  --user <id>          Who to sign in as: an email address for GOV.UK One
                       Login, or a 12-digit ID for Government Gateway. Also
                       read from BNG_USERNAME or DEFRA_ID_USERNAME. Not needed
                       with --manual-login.

Password (pick one)
  --password <pw>      Read from BNG_PASSWORD if omitted. If neither is set the
                       script prompts, which keeps it out of your shell history.
  --manual-login       Skip all of that: sign in yourself in a visible window,
                       once, and the session is reused by every upload window.
                       The answer to MFA, which cannot be automated.

Options
  --count <n>          Windows / concurrent uploads. Default ${DEFAULT_COUNT},
                       capped at ${MAX_WINDOWS} - past that the browsers contend
                       with each other and you are measuring this machine.
  --size <label>       Which of the suite's baselines to upload:
                       normal (80 parcels) | busy (800) | large (5,000) |
                       xlarge (12,000). Default ${DEFAULT_SIZE}.
  --file <path>        Upload a GeoPackage of your own instead of --size.
  --auth <provider>    one-login | government-gateway | auto (default).
                       auto drives whichever sign-in page actually renders.
  --cols <n>           Tile columns. Default: roughly square.
  --screen <WxH>       Override detected screen size, e.g. --screen 3440x1440.
  --stagger <ms>       Delay between submissions. Default 0 — a true burst.
  --headless           No windows. Useful for a quick pass/fail count.
  --keep-open          Leave the windows up at the end until you press Enter.
  --timeout <ms>       Per-upload outcome budget. Default ${OUTCOME_TIMEOUT}.
  --help               This text.

Examples
  # Four windows at the dev environment
  node scripts/concurrent-uploads.mjs \\
    --url https://bng-metric-frontend.dev.cdp-int.defra.cloud --user 123456789012

  # Nine 12,000-parcel uploads at once, on an ultrawide, left up to inspect
  BNG_PASSWORD=... node scripts/concurrent-uploads.mjs \\
    --url https://bng-metric-frontend.dev.cdp-int.defra.cloud \\
    --user 123456789012 --count 9 --size xlarge --screen 3440x1440 --keep-open
`

export function parseArgs(argv) {
  const flags = new Set([
    '--headless',
    '--keep-open',
    '--manual-login',
    '--help',
    '-h'
  ])
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--') && arg !== '-h') {
      throw new Error(`Unexpected argument "${arg}"`)
    }
    const key = arg.replace(/^--?/, '')
    if (flags.has(arg)) {
      out[key] = true
      continue
    }
    const value = argv[++i]
    if (value === undefined) {
      throw new Error(`${arg} needs a value`)
    }
    out[key] = value
  }
  return out
}

/**
 * Ask for the password on the terminal rather than taking it on the command
 * line, so it does not end up in shell history or in `ps` output.
 */
function promptForPassword() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  return new Promise((resolve) => {
    // No masking: Node's readline cannot hide input without taking over the
    // TTY, and a half-working mask is worse than an honest prompt.
    rl.question('Password (will be visible): ', (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

/**
 * Work out how big the screen is, so the tiling has something to divide up.
 *
 * Best effort by design: every branch has a fallback, because guessing a
 * slightly wrong screen size makes the windows a bit off, while failing here
 * would stop a run that would otherwise have worked.
 */
export function detectScreen() {
  try {
    if (process.platform === 'darwin') {
      const bounds = execFileSync(
        'osascript',
        ['-e', 'tell application "Finder" to get bounds of window of desktop'],
        { encoding: 'utf8', timeout: 5000 }
      )
      const [, , width, height] = bounds.split(',').map((n) => parseInt(n, 10))
      if (width > 0 && height > 0) {
        return { width, height }
      }
    }
    if (process.platform === 'linux') {
      const out = execFileSync('xdpyinfo', [], {
        encoding: 'utf8',
        timeout: 5000
      })
      const match = /dimensions:\s+(\d+)x(\d+)/.exec(out)
      if (match) {
        return { width: Number(match[1]), height: Number(match[2]) }
      }
    }
  } catch {
    // No osascript, no X display, a sandbox that forbids either — the default
    // below is a perfectly good answer.
  }
  return DEFAULT_SCREEN
}

/**
 * Lay `count` windows out over the screen.
 *
 * Columns default to roughly square rather than a fixed number: a 2-window run
 * wants side-by-side, a 9-window run wants a 3x3, and neither should need a
 * flag to say so.
 */
export function tile(count, screen, requestedCols) {
  const cols = requestedCols
    ? Math.max(1, Math.min(requestedCols, count))
    : Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const top = process.platform === 'darwin' ? MAC_MENU_BAR_PX : 0
  const width = Math.floor(screen.width / cols)
  const height = Math.floor((screen.height - top) / rows)
  const cells = []
  for (let i = 0; i < count; i++) {
    cells.push({
      x: (i % cols) * width,
      y: top + Math.floor(i / cols) * height,
      width,
      height
    })
  }
  return { cells, cols, rows, width, height }
}

/**
 * Sign in, whichever provider the service is wired to.
 *
 * The journey suite's DefraIdLoginFlow drives Defra ID (Azure AD B2C ->
 * Government Gateway), which is what the deployed environments use. One Login
 * is handled too because the two are easy to confuse and the cost of covering
 * both is one extra branch: rather than assume, wait to see which set of
 * controls renders and drive that one.
 *
 * Selectors mirror test/pages/defra-id-login.page.js. If the hosted pages
 * change, that page object is the thing to re-verify against a headed run.
 */
export async function signInGovernmentGateway(page, username, password) {
  await page
    .getByRole('radio', { name: 'Sign in with Government Gateway' })
    .check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel('Government Gateway user ID').fill(username)
  // exact: true — the GOV.UK password field has a "Show password" toggle whose
  // accessible name also contains "password".
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

export async function signInOneLogin(page, email, password) {
  // One Login sometimes shows a "sign in or create an account" step first. It
  // is not always there — depends on the service's configuration — so click it
  // only if it is, rather than waiting for something that may never come.
  const signInFirst = page.getByRole('button', { name: /^Sign in$/ })
  if (await signInFirst.isVisible().catch(() => false)) {
    await signInFirst.click()
  }

  await page.getByLabel(/email address/i).fill(email)
  await page.getByRole('button', { name: /Continue|Sign in/ }).click()

  // NOT getByLabel(/password/i): One Login renders a "Show password" toggle
  // whose label also contains the word, so a loose match resolves to two
  // elements and Playwright refuses to act on either. The input type is the
  // one thing that identifies this field unambiguously.
  await page.locator('input[type="password"]').fill(password)
  await page.getByRole('button', { name: /Continue|Sign in/ }).click()
}

/**
 * Sign in, and say something useful when it cannot.
 *
 * Provider detection rather than assumption: these repos carry no One Login
 * reference at all — the journey suite drives Defra ID (Azure AD B2C ->
 * Government Gateway) — but the frontend only ever sees a generic
 * `OIDC_DISCOVERY_URL` set per environment in the CDP Portal, so which provider
 * answers is a deployment fact this code cannot read. Waiting to see which
 * controls render costs one race and removes the guess. `--auth` forces it when
 * detection gets it wrong.
 *
 * MFA is the case worth naming explicitly. One Login enforces a second factor
 * as a matter of course, and no amount of selector work automates a code sent
 * to someone's phone. Rather than time out with "could not find the password
 * field", this detects the prompt and points at --manual-login, which sidesteps
 * the whole question by letting a human do the sign-in once.
 */
export async function signIn(page, baseUrl, username, password, provider) {
  await page.goto(`${baseUrl}/auth/login`, { waitUntil: 'domcontentloaded' })

  const governmentGateway = page.getByRole('radio', {
    name: 'Sign in with Government Gateway'
  })
  // Label-first per the journey suite's conventions. One Login's first screen
  // asks for an email address; Government Gateway's asks you to pick a provider.
  const oneLoginEmail = page.getByLabel(/email address/i)

  let useGovernmentGateway
  if (provider === 'government-gateway') {
    useGovernmentGateway = true
  } else if (provider === 'one-login') {
    useGovernmentGateway = false
  } else {
    await Promise.race([
      governmentGateway.waitFor({ timeout: LOGIN_TIMEOUT }),
      oneLoginEmail.waitFor({ timeout: LOGIN_TIMEOUT })
    ])
    useGovernmentGateway = await governmentGateway
      .isVisible()
      .catch(() => false)
  }

  if (useGovernmentGateway) {
    await signInGovernmentGateway(page, username, password)
  } else {
    await signInOneLogin(page, username, password)
  }

  // Landing on either page means authenticated: a completer with projects gets
  // the dashboard, one without gets sent straight to create their first.
  const landed = page
    .waitForURL(/\/manage-projects|\/project-name/, {
      timeout: LOGIN_TIMEOUT,
      waitUntil: 'domcontentloaded'
    })
    .then(() => 'in')
  const secondFactor = page
    .getByText(/security code|6.digit code|two.factor|authenticator/i)
    .waitFor({ timeout: LOGIN_TIMEOUT })
    .then(() => 'mfa')

  const result = await Promise.race([
    landed,
    secondFactor.catch(() => new Promise(() => {}))
  ])
  if (result === 'mfa') {
    throw new Error(
      'the provider is asking for a second factor, which cannot be automated. ' +
        'Re-run with --manual-login and sign in yourself once.'
    )
  }
}

/**
 * Let a human sign in, once, in a window they can see.
 *
 * The reliable answer to MFA, to a provider whose pages have been redesigned,
 * and to anything else that makes scripted sign-in brittle. You are sitting in
 * front of this tool anyway — it exists to be watched — so one manual sign-in
 * costs almost nothing and removes every assumption this script would otherwise
 * make about somebody else's login pages.
 */
export async function manualSignIn(page, baseUrl) {
  await page.goto(`${baseUrl}/auth/login`, { waitUntil: 'domcontentloaded' })
  info('')
  info(
    color(
      'yellow',
      '  A browser window is open. Sign in there — including any security code.'
    )
  )
  info(color('grey', `  Waiting up to ${MANUAL_LOGIN_TIMEOUT / 60000} minutes.`))
  await page.waitForURL(/\/manage-projects|\/project-name/, {
    timeout: MANUAL_LOGIN_TIMEOUT,
    waitUntil: 'domcontentloaded'
  })
}

/**
 * Create a project and stop on the upload form with the file already chosen.
 *
 * Everything slow and uninteresting happens here, before the starting line, so
 * that the only thing left to do when the barrier lifts is submit.
 */
export async function stageUpload(page, baseUrl, filePath, label) {
  await page.goto(`${baseUrl}/manage-projects`, {
    waitUntil: 'domcontentloaded',
    timeout: SETUP_TIMEOUT
  })

  // A user with no projects is redirected straight to /project-name, in which
  // case there is no button to press. Mirrors CreateProjectFlow.
  if (!page.url().includes('/project-name')) {
    await page.getByRole('button', { name: 'Create project' }).click()
  }
  // The name field is the only textbox on the page; DefineProjectNamePage
  // addresses it the same way.
  await page.getByRole('textbox').fill(label)
  await page.getByRole('button', { name: 'Save and continue' }).click()

  // Creating a project returns to the dashboard with the new project listed —
  // it does NOT go on to the project itself. The id is only available from that
  // row's link, whose href is /add-project-details/<id>, which is where
  // setupProject reads it from too.
  await page.waitForURL(/\/manage-projects/, { timeout: SETUP_TIMEOUT })
  const href = await page
    .getByRole('link', { name: label })
    .getAttribute('href')
  const projectId = href?.split('/').pop()
  if (!projectId) {
    throw new Error(`Could not read a project id from "${href}"`)
  }

  await page.goto(`${baseUrl}/projects/${projectId}/upload-baseline-file`, {
    waitUntil: 'domcontentloaded',
    timeout: SETUP_TIMEOUT
  })
  // The GOV.UK enhanced file upload hides the real input behind a button, so
  // setInputFiles has to target the input itself.
  await page.locator('input[type="file"]').setInputFiles(filePath)

  return projectId
}

/** Resolve to `label`, or stay pending forever if the wait rejects. */
function settle(promise, label) {
  return promise.then(
    () => label,
    () => new Promise(() => {})
  )
}

/**
 * Watch one window until the service has said something conclusive.
 *
 * Four ways a burst ends, and they mean different things: the summary page
 * means the file was validated, /error-file means it was looked at and refused,
 * the busy message means it was never looked at and the user should retry, and
 * the frontend's own give-up page means it polled for two minutes and stopped.
 * Collapsing them into pass/fail would hide the distinction the whole exercise
 * is about.
 */
export function awaitOutcome(page, projectId, timeoutMs) {
  const options = { timeout: timeoutMs }
  return Promise.race([
    settle(
      page.waitForURL(
        new RegExp(`/projects/${projectId}/project-summary`),
        options
      ),
      'validated'
    ),
    settle(page.waitForURL(/\/error-file/, options), 'rejected'),
    settle(page.getByText(/service is busy/i).waitFor(options), 'busy'),
    settle(
      page
        .getByText(/taking longer than expected|try again later/i)
        .waitFor(options),
      'gave up'
    ),
    new Promise((resolve) => setTimeout(() => resolve('no answer'), timeoutMs))
  ])
}

/** One window: its own browser process, placed on the screen. */
export async function openWindow(cell, { headless, storageState, baseUrl }) {
  const proxyServer = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--window-position=${cell.x},${cell.y}`,
      `--window-size=${cell.width},${cell.height}`,
      // Force HTTP/1.1 through the CDP egress proxy, which otherwise trips
      // ERR_HTTP2_PROTOCOL_ERROR. Mirrors the journey suite's auth setup.
      ...(proxyServer ? ['--disable-http2'] : [])
    ],
    ...(proxyServer && {
      proxy: {
        server: proxyServer,
        bypass: 'localhost,127.0.0.1,.cdp-int.defra.cloud'
      }
    })
  })
  // viewport: null makes the page fill the window we just sized, rather than
  // Playwright's own 1280x720 default sitting inside it.
  const context = await browser.newContext({
    storageState,
    baseURL: baseUrl,
    viewport: null
  })
  return { browser, context, page: await context.newPage() }
}

const OUTCOME_TONES = {
  validated: 'green',
  rejected: 'red',
  busy: 'yellow',
  'gave up': 'yellow',
  'no answer': 'red',
  error: 'red'
}

export function summarise(results, fileLabel, count) {
  const width = Math.max(...results.map((r) => r.label.length), 6)
  info('')
  info(color('blue', `Results - ${count} concurrent uploads of ${fileLabel}`))
  info('')
  info(`  ${'window'.padEnd(width)}  ${'outcome'.padEnd(10)}  elapsed   detail`)
  for (const r of results) {
    const seconds =
      r.elapsedMs === null ? '-' : `${(r.elapsedMs / 1000).toFixed(1)}s`
    info(
      `  ${r.label.padEnd(width)}  ` +
        `${color(OUTCOME_TONES[r.outcome] ?? 'grey', r.outcome.padEnd(10))}  ` +
        `${seconds.padStart(7)}   ${color('grey', r.detail ?? r.projectId ?? '')}`
    )
  }

  const tally = results.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1
    return acc
  }, {})
  info('')
  info(
    '  ' +
      Object.entries(tally)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')
  )

  // `busy` is a healthy response to a burst, not a failure — the service said
  // "come back" and a real browser would have retried. Only the rest mean
  // something went wrong that a user could not recover from.
  const broken =
    (tally.rejected ?? 0) + (tally['no answer'] ?? 0) + (tally.error ?? 0)
  if (broken > 0) {
    info('')
    warn(`${broken} upload(s) did not complete - see the windows for detail`)
  }
  return broken
}

async function closeAll(windows) {
  await Promise.all(
    windows.map((w) => w.browser.close().catch(() => undefined))
  )
}

/**
 * How many windows, refusing anything the machine cannot usefully show.
 *
 * Separate from the rest of option parsing so the cap can be tested without a
 * browser, a URL or a password anywhere near it.
 */
export function parseCount(value) {
  const count = Number(value ?? DEFAULT_COUNT)
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`--count must be a positive integer, got "${value}"`)
  }
  if (count > MAX_WINDOWS) {
    throw new Error(
      `--count is capped at ${MAX_WINDOWS} windows, got ${count}. ` +
        'Past that the browsers contend with each other and the burst measures ' +
        'this machine rather than the service - use the JMeter suite instead.'
    )
  }
  return count
}

/** The size ladder this suite already generates and commits. */
export async function readSizes() {
  return JSON.parse(await fs.readFile(MANIFEST, 'utf8')).sizes
}

/**
 * Pick the GeoPackage to upload: a size label from the suite's own ladder, or
 * an explicit path for a file of your own.
 */
export async function resolveUploadFile({ file, size }) {
  if (file) {
    return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file)
  }
  const sizes = await readSizes()
  const wanted = size ?? DEFAULT_SIZE
  const match = sizes.find((entry) => entry.label === wanted)
  if (!match) {
    const labels = sizes.map((entry) => entry.label).join(', ')
    throw new Error(`--size must be one of: ${labels}. Got "${wanted}".`)
  }
  return path.join(FIXTURES_DIR, match.file)
}

export function parseScreen(value) {
  if (!value) {
    return null
  }
  const match = /^(\d+)x(\d+)$/i.exec(value)
  if (!match) {
    throw new Error(`--screen must look like 1920x1080, got "${value}"`)
  }
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** Read and validate everything the run needs before anything is launched. */
async function resolveOptions(args) {
  const baseUrl = (args.url ?? process.env.BNG_BASE_URL ?? '').replace(
    /\/+$/,
    ''
  )
  if (!baseUrl) {
    throw new Error('--url is required (see --help)')
  }

  const manualLogin = Boolean(args['manual-login'])
  // DEFRA_ID_USERNAME/PASSWORD is what the journey suite already calls this
  // credential, so an operator who has it exported for an e2e run needs no
  // flags here.
  const username =
    args.user ?? process.env.BNG_USERNAME ?? process.env.DEFRA_ID_USERNAME
  if (!username && !manualLogin) {
    throw new Error('--user is required unless you pass --manual-login')
  }

  const auth = args.auth ?? 'auto'
  if (!AUTH_PROVIDERS.includes(auth)) {
    throw new Error(`--auth must be one of: ${AUTH_PROVIDERS.join(', ')}`)
  }

  const count = parseCount(args.count)

  const filePath = await resolveUploadFile(args)
  await fs.access(filePath)

  // Everything cheap is validated before the prompt, so a typo in --screen
  // fails immediately rather than after you have typed a password.
  const screen = parseScreen(args.screen) ?? detectScreen()

  // Nothing is asked for when a human is doing the signing in.
  let password = null
  if (!manualLogin) {
    password =
      args.password ??
      process.env.BNG_PASSWORD ??
      process.env.DEFRA_ID_PASSWORD ??
      (await promptForPassword())
    if (!password) {
      throw new Error('A password is required')
    }
  }

  return {
    baseUrl,
    username,
    password,
    auth,
    manualLogin,
    count,
    filePath,
    headless: Boolean(args.headless),
    keepOpen: Boolean(args['keep-open']),
    staggerMs: Number(args.stagger ?? 0),
    outcomeTimeout: Number(args.timeout ?? OUTCOME_TIMEOUT),
    screen,
    cols: args.cols ? Number(args.cols) : undefined
  }
}

function describeRun(opts, layout) {
  info(color('blue', `> ${opts.baseUrl}`))
  info(`  file     ${path.basename(opts.filePath)}`)
  info(`  windows  ${opts.count} (${layout.cols}x${layout.rows} grid)`)
  if (!opts.headless) {
    info(
      `  screen   ${opts.screen.width}x${opts.screen.height}, ` +
        `each window ${layout.width}x${layout.height}`
    )
    if (layout.width < MIN_USABLE_WIDTH || layout.height < MIN_USABLE_HEIGHT) {
      warn(
        `windows will be ${layout.width}x${layout.height} - too small to read. ` +
          'Use fewer windows, --cols, or --headless.'
      )
    }
  }
}

/** Sign in once and return the path to a storage state every window can share. */
async function mintSession(opts) {
  const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bng-burst-'))
  const statePath = path.join(authDir, 'state.json')
  // Headed for a manual sign-in, for the obvious reason.
  const browser = await chromium.launch({
    headless: !opts.manualLogin,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })
  try {
    const context = await browser.newContext({ baseURL: opts.baseUrl })
    const page = await context.newPage()
    if (opts.manualLogin) {
      await manualSignIn(page, opts.baseUrl)
    } else {
      await signIn(
        page,
        opts.baseUrl,
        opts.username,
        opts.password,
        opts.auth
      )
    }
    await context.storageState({ path: statePath })
    await context.close()
    return { authDir, statePath }
  } finally {
    await browser.close()
  }
}

async function waitForEnter(question) {
  await new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })
    rl.question(question, () => {
      rl.close()
      resolve()
    })
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) {
    info(HELP)
    return 0
  }

  const opts = await resolveOptions(args)
  const layout = tile(opts.count, opts.screen, opts.cols)
  describeRun(opts, layout)

  info('')
  info(
    opts.manualLogin
      ? '> waiting for you to sign in (once - every window reuses the session)'
      : '> signing in (the slow bit - one login, shared by every window)'
  )
  let session
  try {
    session = await mintSession(opts)
    info(color('green', '  signed in'))
  } catch (err) {
    fail(`Sign-in failed: ${err.message}`)
    info(
      color(
        'grey',
        '  --manual-login lets you sign in by hand once, which works whatever\n' +
          '  the provider asks for. --auth forces a provider if detection\n' +
          '  picked the wrong one.'
      )
    )
    return 1
  }

  info('')
  info(`> opening ${opts.count} window(s) and staging the upload in each`)
  const stamp = Date.now()
  const windows = await Promise.all(
    layout.cells.map((cell) =>
      openWindow(cell, {
        headless: opts.headless,
        storageState: session.statePath,
        baseUrl: opts.baseUrl
      })
    )
  )

  const staged = await Promise.all(
    windows.map(async (win, i) => {
      const label = `#${i + 1}`
      try {
        const projectId = await stageUpload(
          win.page,
          opts.baseUrl,
          opts.filePath,
          `Burst ${stamp} ${label}`
        )
        info(color('grey', `  ${label} ready - project ${projectId}`))
        return { label, projectId, win, ready: true }
      } catch (err) {
        fail(`  ${label} could not be staged: ${err.message}`)
        return { label, win, ready: false, detail: err.message }
      }
    })
  )

  const ready = staged.filter((s) => s.ready)
  if (ready.length === 0) {
    fail('No window reached the upload form - nothing to submit')
    await closeAll(windows)
    return 1
  }
  if (ready.length < opts.count) {
    warn(`${opts.count - ready.length} window(s) never reached the form`)
  }

  info('')
  info(
    color(
      'blue',
      `> submitting ${ready.length} upload(s)` +
        (opts.staggerMs > 0
          ? ` at ${opts.staggerMs} ms intervals`
          : ' simultaneously')
    )
  )
  const firedAt = Date.now()
  const results = await Promise.all(
    ready.map(async (s, i) => {
      if (opts.staggerMs > 0 && i > 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.staggerMs * i))
      }
      try {
        await s.win.page.getByRole('button', { name: 'Continue' }).click()
        const outcome = await awaitOutcome(
          s.win.page,
          s.projectId,
          opts.outcomeTimeout
        )
        return {
          label: s.label,
          projectId: s.projectId,
          outcome,
          elapsedMs: Date.now() - firedAt
        }
      } catch (err) {
        return {
          label: s.label,
          projectId: s.projectId,
          outcome: 'error',
          detail: err.message,
          elapsedMs: Date.now() - firedAt
        }
      }
    })
  )

  for (const s of staged.filter((x) => !x.ready)) {
    results.push({
      label: s.label,
      outcome: 'error',
      detail: s.detail,
      elapsedMs: null
    })
  }
  results.sort((a, b) =>
    a.label.localeCompare(b.label, 'en', { numeric: true })
  )

  const broken = summarise(results, path.basename(opts.filePath), ready.length)

  if (opts.keepOpen && !opts.headless) {
    info('')
    await waitForEnter('Windows left open. Press Enter to close them... ')
  }

  await closeAll(windows)
  await fs.rm(session.authDir, { recursive: true, force: true })
  return broken > 0 ? 1 : 0
}

// Guarded so the helpers above can be imported and exercised without the
// script firing a burst at somebody's environment as a side effect.
const isEntryPoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      fail(err.message)
      process.exit(1)
    })
}
