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

/** Enough of a page to recognise it by, without pasting the whole DOM. */
const MAX_REPORTED_CONTROLS = 8

const MS_PER_SECOND = 1000

/**
 * Budget for a single Playwright action — finding a control, filling it,
 * clicking it.
 *
 * Playwright's own default is 30 s, which is generous for one window and not
 * for eight: with that many browsers on one machine, all pushing a large file
 * at the same service, everything from a form fill to a page render is slower
 * than it would be alone. This is a budget for the BROWSER being busy, not for
 * the service being slow — the service's budget is the outcome timeout, which
 * is separate and much longer.
 */
const DEFAULT_ACTION_TIMEOUT = 60_000

/** A notification banner's worth of text, not a whole page of it. */
const MAX_MESSAGE_CHARS = 200

/**
 * How long the windows stay up after the run, so the last page each one reached
 * can actually be read.
 *
 * The point of this tool is watching, and the most interesting moment is the
 * one right at the end — which is exactly the moment the windows were being
 * torn down. A few seconds costs nothing and is the difference between seeing
 * the result and being told about it.
 */
const DEFAULT_LINGER_SECONDS = 10
const SETUP_TIMEOUT = 60_000
const OUTCOME_TIMEOUT = 150_000

/** macOS reserves the top of the screen for the menu bar. */
const MAC_MENU_BAR_PX = 28

/** Below this a Chromium window is too small to read anything in. */
const MIN_USABLE_WIDTH = 480
const MIN_USABLE_HEIGHT = 360

const DEFAULT_SCREEN = { width: 1920, height: 1080 }

/** Gitignored in this repo, so a failure screenshot cannot be committed. */
const REPORT_DIR = path.join(REPO_ROOT, 'reports')

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
  --share-session      Let every window share the one sign-in. Faster, but the
                       upload journey keeps per-USER session state, so
                       concurrent uploads then clobber each other. Only safe
                       with --count 1.
  --show-login         Drive the scripted sign-in in a VISIBLE window, so you
                       can watch which provider answers and where it sticks.
                       On failure the page is described and screenshotted
                       either way.

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
  --linger <seconds>   Keep the windows up this long after the run, so you can
                       read the final page. Default ${DEFAULT_LINGER_SECONDS};
                       0 closes immediately.
  --keep-open          Leave the windows up until you press Enter instead.
  --timeout <ms>       Per-upload outcome budget. Default ${OUTCOME_TIMEOUT}.
  --action-timeout <ms> Budget for one browser action. Default
                       ${DEFAULT_ACTION_TIMEOUT} — raise it if many windows on a
                       busy machine start timing out on clicks and fills.
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

/** Options that take a value. Anything else with a `--` is a mistake. */
const VALUE_OPTIONS = new Set([
  '--url',
  '--user',
  '--password',
  '--auth',
  '--count',
  '--size',
  '--file',
  '--cols',
  '--screen',
  '--stagger',
  '--timeout',
  '--linger',
  '--action-timeout'
])

/** Options that are on or off. */
const FLAG_OPTIONS = new Set([
  '--headless',
  '--keep-open',
  '--manual-login',
  '--show-login',
  '--share-session',
  '--help',
  '-h'
])

/**
 * Read the command line, and refuse anything it does not recognise.
 *
 * The refusal is the point. This used to treat every unrecognised `--thing` as
 * value-taking, so running with a flag from a newer version than the one
 * checked out swallowed the NEXT option as its value and then failed on that
 * option's value — reporting `Unexpected argument "normal"` for a command whose
 * actual problem was an unknown `--show-login` three arguments earlier. An
 * error naming the thing that is wrong is worth more than one naming where the
 * parser happened to give up.
 */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('-')) {
      throw new Error(
        `Unexpected argument "${arg}" — every option starts with --, see --help`
      )
    }
    const key = arg.replace(/^--?/, '')
    if (FLAG_OPTIONS.has(arg)) {
      out[key] = true
      continue
    }
    if (!VALUE_OPTIONS.has(arg)) {
      throw new Error(
        `Unknown option "${arg}". Run --help for the list; if you expected ` +
          'this one, the checkout may be behind (git pull).'
      )
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
  const { stdin, stdout } = process

  // Without a TTY there is no keypress stream to intercept — a piped or CI
  // stdin has to be read the ordinary way, and masking it is meaningless.
  if (!stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: stdout })
    return new Promise((resolve) => {
      rl.question('Password: ', (answer) => {
        rl.close()
        resolve(answer)
      })
    })
  }

  // Raw mode so each keypress arrives here instead of being echoed by the
  // terminal, which is the only way to print a star in its place.
  return new Promise((resolve) => {
    stdout.write('Password: ')
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let value = ''
    const finish = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      stdout.write('\n')
    }

    function onData(chunk) {
      // A chunk, not a character: a paste arrives whole, and so do the escape
      // sequences an arrow key sends.
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          finish()
          resolve(value)
          return
        }
        if (char === '\u0003') {
          finish()
          process.exit(130)
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            stdout.write('\b \b')
          }
          continue
        }
        // Drop anything else non-printable rather than starring it, so an
        // arrow key does not silently add three characters to the password.
        if (char >= ' ') {
          value += char
          stdout.write('*')
        }
      }
    }

    stdin.on('data', onData)
  })
}

/**
 * Say what the sign-in page actually was, when driving it did not work.
 *
 * A timeout naming the locator that failed says what this script expected, not
 * what it found — and what it found is the whole question when the provider is
 * a deployment detail set outside these repos. So: the URL it ended on, the
 * headings, and every control it can see, plus a screenshot. That is usually
 * enough to tell which provider answered and which selector to reach for,
 * without anyone having to reproduce it by hand.
 */
export async function describeSignInPage(page, reportDir) {
  const lines = []
  const safely = async (what, fn) => {
    try {
      return await fn()
    } catch {
      lines.push(`  (could not read ${what})`)
      return []
    }
  }

  lines.push(`  url: ${page.url()}`)

  const headings = await safely('headings', () =>
    page.locator('h1, h2').allInnerTexts()
  )
  for (const heading of headings.slice(0, MAX_REPORTED_CONTROLS)) {
    lines.push(`  heading: ${heading.trim().replaceAll('\n', ' ')}`)
  }

  const buttons = await safely('buttons', () =>
    page.getByRole('button').allInnerTexts()
  )
  for (const button of buttons.slice(0, MAX_REPORTED_CONTROLS)) {
    const text = button.trim()
    if (text) {
      lines.push(`  button: ${text}`)
    }
  }

  const inputs = await safely('inputs', () =>
    page.locator('input:not([type=hidden])').evaluateAll((nodes) =>
      nodes.map((node) => {
        const label = node.labels?.[0]?.innerText ?? ''
        return `${node.type || 'text'}${label ? ` — "${label.trim()}"` : ''}`
      })
    )
  )
  for (const input of inputs.slice(0, MAX_REPORTED_CONTROLS)) {
    lines.push(`  input: ${input}`)
  }

  try {
    await fs.mkdir(reportDir, { recursive: true })
    const shot = path.join(reportDir, 'signin-failure.png')
    await page.screenshot({ path: shot, fullPage: true })
    lines.push(`  screenshot: ${shot}`)
  } catch {
    lines.push('  (could not save a screenshot)')
  }

  return lines.join('\n')
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
/**
 * Pick an identity provider on the Defra ID chooser, if that is where we are.
 *
 * Defra ID (Azure AD B2C) fronts more than one IdP, so `/auth/login` lands on a
 * page of radios rather than on a sign-in form. Which one you want is a
 * preference this code cannot infer — both are legitimate — so `--auth` is how
 * you say, and `auto` keeps the behaviour the journey suite has always had.
 *
 * Names are matched loosely on purpose. The exact wording is Defra ID's to
 * change and is not in any repo here; "One Login" and "Government Gateway" are
 * the parts that carry the meaning, and matching those survives a relabelling
 * that an exact string would not.
 *
 * @returns {string|null} the provider chosen, or null if this is not a chooser
 */
export async function chooseIdentityProvider(page, provider) {
  const options = {
    'government-gateway': {
      radio: page.getByRole('radio', { name: /government gateway/i }),
      label: 'Government Gateway'
    },
    'one-login': {
      radio: page.getByRole('radio', { name: /one.?login/i }),
      label: 'GOV.UK One Login'
    }
  }

  const visible = {}
  for (const [key, option] of Object.entries(options)) {
    visible[key] = await option.radio.isVisible().catch(() => false)
  }
  if (!visible['government-gateway'] && !visible['one-login']) {
    return null
  }

  // `auto` prefers Government Gateway when both are offered — it is what the
  // journey suite drives, so it is the path with known-good selectors. Said out
  // loud rather than silently, because the other option is right there.
  let wanted = provider
  if (provider === 'auto') {
    wanted = visible['government-gateway'] ? 'government-gateway' : 'one-login'
    if (visible['government-gateway'] && visible['one-login']) {
      info(
        color(
          'grey',
          '  both providers offered; choosing Government Gateway ' +
            '(--auth one-login for the other)'
        )
      )
    }
  }

  if (!visible[wanted]) {
    const offered = Object.entries(visible)
      .filter(([, isVisible]) => isVisible)
      .map(([key]) => key)
      .join(', ')
    throw new Error(
      `the sign-in page does not offer ${options[wanted].label}. It offers: ${offered}`
    )
  }

  await options[wanted].radio.check()
  info(color('grey', `  signing in with ${options[wanted].label}`))
  await page.getByRole('button', { name: /Continue|Next/ }).click()
  return wanted
}

/** The Government Gateway user-ID and password pages, after the chooser. */
export async function signInGovernmentGateway(page, username, password) {
  await page.getByLabel('Government Gateway user ID').fill(username)
  // exact: true — the GOV.UK password field has a "Show password" toggle whose
  // accessible name also contains "password".
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/**
 * Get the cookie banner out of the way.
 *
 * GOV.UK renders it hidden and reveals it with JavaScript, so it can appear
 * after the page is otherwise ready and sit over the top of the controls we are
 * about to click. Rejecting is the conservative choice — it is analytics only,
 * and this is a robot.
 */
async function dismissCookieBanner(page) {
  const reject = page.getByRole('button', {
    name: /Reject analytics cookies/i
  })
  if (await reject.isVisible().catch(() => false)) {
    await reject.click().catch(() => {})
  }
}

/**
 * The GOV.UK One Login sign-in pages.
 *
 * Every step waits for the control it is about to use. This is reached through
 * a redirect chain out of Defra ID, so at the moment this function is called
 * the browser is usually still navigating and NOTHING is on screen yet — an
 * immediate isVisible() check answers false for a button that appears a moment
 * later, which is how the first version silently skipped the "Create your
 * GOV.UK One Login or sign in" interstitial and then timed out looking for an
 * email field that was one click away.
 */
export async function signInOneLogin(page, email, password) {
  const signInButton = page.getByRole('button', { name: /^Sign in$/ })
  const emailField = page.getByLabel(/email address/i)

  // Either the interstitial or the email form — which one depends on the
  // service's configuration, so wait for whichever arrives.
  await Promise.race([
    signInButton.waitFor({ timeout: LOGIN_TIMEOUT }),
    emailField.waitFor({ timeout: LOGIN_TIMEOUT })
  ])
  await dismissCookieBanner(page)

  if (await signInButton.isVisible().catch(() => false)) {
    await signInButton.click()
  }

  await emailField.waitFor({ timeout: LOGIN_TIMEOUT })
  await emailField.fill(email)
  await page.getByRole('button', { name: /Continue|Sign in/ }).click()

  // NOT getByLabel(/password/i): One Login renders a "Show password" toggle
  // whose label also contains the word, so a loose match resolves to two
  // elements and Playwright refuses to act on either. The input type is the
  // one thing that identifies this field unambiguously.
  const passwordField = page.locator('input[type="password"]')
  await passwordField.waitFor({ timeout: LOGIN_TIMEOUT })
  await passwordField.fill(password)
  await page.getByRole('button', { name: /Continue|Sign in/ }).click()
}

/**
 * Sign in, and say something useful when it cannot.
 *
 * Two shapes to handle. `/auth/login` may land on the Defra ID chooser — a page
 * of identity providers — or straight on a provider's own first form, depending
 * on how the environment's OIDC_DISCOVERY_URL is configured. So: wait to see
 * which, pick a provider if asked to, then drive that provider's pages.
 *
 * MFA is the case worth naming explicitly. One Login enforces a second factor
 * as a matter of course and no amount of selector work automates a code sent to
 * someone's phone, so this detects the prompt and points at --manual-login
 * rather than timing out on a field that will never appear.
 */
export async function signIn(page, baseUrl, username, password, provider) {
  await page.goto(`${baseUrl}/auth/login`, { waitUntil: 'domcontentloaded' })

  // Anything recognisable: either chooser radio, or a provider's first field.
  await Promise.race([
    page
      .getByRole('radio', { name: /government gateway|one.?login/i })
      .first()
      .waitFor({ timeout: LOGIN_TIMEOUT }),
    page.getByLabel(/email address/i).waitFor({ timeout: LOGIN_TIMEOUT }),
    page
      .getByLabel('Government Gateway user ID')
      .waitFor({ timeout: LOGIN_TIMEOUT })
  ])

  const chosen = await chooseIdentityProvider(page, provider)

  // No chooser: we are already on a provider's own pages. Believe --auth if it
  // was given, otherwise tell them apart by which field is present.
  let driving = chosen
  if (!driving) {
    if (provider !== 'auto') {
      driving = provider
    } else {
      const isGovernmentGateway = await page
        .getByLabel('Government Gateway user ID')
        .isVisible()
        .catch(() => false)
      driving = isGovernmentGateway ? 'government-gateway' : 'one-login'
    }
  }

  if (driving === 'government-gateway') {
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
  // By URL, and by the code field itself — NOT by prose. One Login's own
  // "Create your GOV.UK One Login or sign in" page explains that you will need
  // "a way to get security codes", and matching page text would call that page
  // a second-factor prompt before sign-in had even started.
  const secondFactor = Promise.race([
    page.waitForURL(/enter-code|authenticator|mfa|2fa/i, {
      timeout: LOGIN_TIMEOUT
    }),
    page
      .getByLabel(/security code|access code/i)
      .waitFor({ timeout: LOGIN_TIMEOUT })
  ]).then(() => 'mfa')

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
export async function awaitOutcome(page, projectId, timeoutMs) {
  const options = { timeout: timeoutMs }
  const label = await Promise.race([
    settle(
      page.waitForURL(
        new RegExp(`/projects/${projectId}/project-summary`),
        options
      ),
      'validated'
    ),
    settle(page.waitForURL(/\/error-file/, options), 'rejected'),
    settle(page.getByText(/service is busy/i).first().waitFor(options), 'busy'),
    settle(
      page
        .getByText(/taking longer than expected|try again later/i)
        .first()
        .waitFor(options),
      'gave up'
    ),
    // Back on the upload form with something to say. The upload page renders
    // every message this way (UploadHabitatFilePage's errorSummary), so this
    // catches both "busy, come back" and a real complaint about the file —
    // which is why the text decides which it was rather than the locator.
    settle(page.getByRole('alert').first().waitFor(options), 'returned'),
    new Promise((resolve) => setTimeout(() => resolve('no answer'), timeoutMs))
  ])

  if (label !== 'returned' && label !== 'busy') {
    return { outcome: label, detail: null }
  }

  const text = await page
    .getByRole('alert')
    .first()
    .innerText()
    .catch(() => '')
  const message = text.replaceAll(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS)
  if (/busy/i.test(message) || label === 'busy') {
    return { outcome: 'busy', detail: message || null }
  }
  return { outcome: 'returned', detail: message || page.url() }
}

/**
 * Note every request this window makes to the service, so a window that ends
 * somewhere unexpected can say what the service actually answered.
 *
 * Static assets are dropped: a page load is a hundred of them and none carry
 * the answer. What is left is the journey — the upload POST, the status polls,
 * the validate call — and its status codes, which is the thing worth reading
 * when a window lands back on the form with no explanation.
 */
export function recordNetwork(page, baseUrl) {
  const entries = []
  const interesting = (url) =>
    url.startsWith(baseUrl) &&
    !/\.(css|js|mjs|png|jpe?g|gif|svg|ico|woff2?|ttf|map)(\?|$)/i.test(url)

  page.on('response', (response) => {
    const url = response.url()
    if (!interesting(url)) {
      return
    }
    entries.push({
      status: response.status(),
      method: response.request().method(),
      path: url.slice(baseUrl.length) || '/'
    })
  })
  page.on('requestfailed', (request) => {
    const url = request.url()
    if (!interesting(url)) {
      return
    }
    entries.push({
      status: 'FAILED',
      method: request.method(),
      path: url.slice(baseUrl.length) || '/',
      error: request.failure()?.errorText
    })
  })
  return entries
}

/**
 * Write down what happened to one window that did not simply succeed.
 *
 * A result table says `returned`; it cannot say the upload was refused with a
 * 503 eleven seconds in. The screenshot, the final URL and the request log are
 * what turn "something went wrong" into a diagnosis, and they exist only while
 * the browser is still open — so this runs before anything is closed.
 */
export async function saveWindowEvidence(page, label, entries, result) {
  const slug = label.replaceAll(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  await fs.mkdir(REPORT_DIR, { recursive: true })
  const screenshot = path.join(REPORT_DIR, `burst-${slug}.png`)
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {})

  const failures = entries.filter(
    (entry) => entry.status === 'FAILED' || Number(entry.status) >= 400
  )
  const lines = [
    `window   ${label}`,
    `outcome  ${result.outcome}`,
    result.detail ? `message  ${result.detail}` : null,
    `url      ${page.url()}`,
    '',
    failures.length > 0
      ? `non-OK responses (${failures.length}):`
      : 'no non-OK responses',
    ...failures.map(
      (entry) =>
        `  ${String(entry.status).padStart(6)} ${entry.method.padEnd(4)} ${entry.path}` +
        (entry.error ? ` (${entry.error})` : '')
    ),
    '',
    `all requests (${entries.length}, assets excluded):`,
    ...entries.map(
      (entry) =>
        `  ${String(entry.status).padStart(6)} ${entry.method.padEnd(4)} ${entry.path}`
    )
  ].filter((line) => line !== null)

  const report = path.join(REPORT_DIR, `burst-${slug}.txt`)
  await fs.writeFile(report, `${lines.join('\n')}\n`)
  return { screenshot, report, failures }
}

/**
 * Give this window its OWN frontend session.
 *
 * Sharing one session across every window is wrong for this journey, and
 * silently so. The upload flow keeps its state under session keys scoped to the
 * upload TYPE, not to the project — `pendingUploadId`, `uploadStartedAt` — so
 * two concurrent baseline uploads in one session are writing to the same slot.
 * The first to finish calls clearUploadSession(); the second's next poll finds
 * no pendingUploadId and is redirected back to the upload form with no message
 * at all, because that path sets none. It looks exactly like a failed upload
 * and is nothing of the sort.
 *
 * Re-running /auth/login in a fresh context mints a new frontend session. The
 * IdP cookies came along in the storage state, so its own SSO answers the
 * redirect without asking for anything — no credentials, no second factor.
 */
/**
 * Take the SERVICE's own cookies out of a storage state, leaving the identity
 * provider's.
 *
 * This is what makes a per-window session possible. /auth/login does not
 * short-circuit for an already-authenticated caller: it writes fresh PKCE state
 * into whatever session the cookie names, and the callback writes `auth` into
 * that same one (the only yar.reset() in the auth controller is logout). So
 * handing every window the session cookie from the first sign-in means every
 * window keeps writing into ONE server-side session, no matter how many times
 * they re-authorise.
 *
 * Without that cookie a window is simply unauthenticated: yar mints a new
 * session on the first write and issues its own cookie, and the IdP cookies
 * that are left answer the redirect from SSO without asking for anything. One
 * credential prompt, N independent sessions.
 *
 * @returns {Promise<string>} path to a new state file
 */
export async function stripServiceCookies(statePath, baseUrl, outPath) {
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
  const host = new URL(baseUrl).hostname

  // Drop any cookie the browser would send to the service — by the same
  // host-suffix rule the browser uses, so a domain-wide cookie goes too.
  const belongsToService = (domain = '') => {
    const bare = domain.replace(/^\./, '')
    return host === bare || host.endsWith(`.${bare}`)
  }

  const kept = (state.cookies ?? []).filter(
    (cookie) => !belongsToService(cookie.domain)
  )
  const dropped = (state.cookies ?? []).length - kept.length
  await fs.writeFile(
    outPath,
    JSON.stringify({ ...state, cookies: kept, origins: [] })
  )
  return { path: outPath, kept: kept.length, dropped }
}

/** Does the page show an OAuth/OIDC error rather than a sign-in form? */
async function hasOidcError(page) {
  return page
    .getByText(/invalid_request|error_description|something went wrong/i)
    .first()
    .isVisible()
    .catch(() => false)
}

export async function establishOwnSession(page, baseUrl) {
  await page.goto(`${baseUrl}/auth/login`, {
    waitUntil: 'domcontentloaded',
    timeout: SETUP_TIMEOUT
  })
  try {
    await page.waitForURL(/\/manage-projects|\/project-name/, {
      timeout: LOGIN_TIMEOUT,
      waitUntil: 'domcontentloaded'
    })
  } catch {
    const where = page.url()
    if (/error|mismatch/i.test(where) || (await hasOidcError(page))) {
      throw new Error(
        `the identity provider refused this authorisation (${where}). ` +
          'If it says "interaction session and authentication session ' +
          'mismatch", two windows authorised at once — which this serialises ' +
          'to avoid, so report it.'
      )
    }
    throw new Error(
      `single sign-on did not carry into a new window (ended on ${where}). ` +
        'Re-run with --share-session, accepting that concurrent uploads will ' +
        'then interfere with each other.'
    )
  }
}

/** One window: its own browser process, placed on the screen. */
export async function openWindow(
  cell,
  { headless, storageState, baseUrl, actionTimeout = DEFAULT_ACTION_TIMEOUT }
) {
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
  context.setDefaultTimeout(actionTimeout)
  return { browser, context, page: await context.newPage() }
}

const OUTCOME_TONES = {
  validated: 'green',
  rejected: 'red',
  busy: 'yellow',
  returned: 'yellow',
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

  const withEvidence = results.filter((r) => r.evidence)
  if (withEvidence.length > 0) {
    info('')
    info(color('yellow', '  What the service answered:'))
    for (const r of withEvidence) {
      const failures = r.evidence.failures ?? []
      const summary =
        failures.length > 0
          ? failures
              .map((entry) => `${entry.status} ${entry.method} ${entry.path}`)
              .join(', ')
          : 'no non-OK responses'
      info(`  ${r.label}  ${color('grey', summary)}`)
      info(color('grey', `        ${r.evidence.report}`))
    }
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
    (tally.rejected ?? 0) +
    (tally.returned ?? 0) +
    (tally['no answer'] ?? 0) +
    (tally.error ?? 0)
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
  const showLogin = Boolean(args['show-login'])
  const shareSession = Boolean(args['share-session'])
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
  try {
    await fs.access(filePath)
  } catch {
    // A raw ENOENT names a path the caller may not recognise — a relative
    // --file is resolved against the working directory, not this repo.
    throw new Error(
      `Cannot read the GeoPackage at ${filePath}. Check the --file path ` +
        '(quote it if it contains spaces), or use --size for one of the ' +
        "suite's own fixtures."
    )
  }

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
    showLogin,
    shareSession,
    count,
    filePath,
    headless: Boolean(args.headless),
    keepOpen: Boolean(args['keep-open']),
    staggerMs: Number(args.stagger ?? 0),
    lingerSeconds: Number(args.linger ?? DEFAULT_LINGER_SECONDS),
    outcomeTimeout: Number(args.timeout ?? OUTCOME_TIMEOUT),
    actionTimeout: Number(args['action-timeout'] ?? DEFAULT_ACTION_TIMEOUT),
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
  // Headed for a manual sign-in, for the obvious reason — and for --show-login,
  // where watching the scripted attempt IS the point.
  const browser = await chromium.launch({
    headless: !(opts.manualLogin || opts.showLogin),
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })
  const context = await browser.newContext({ baseURL: opts.baseUrl })
  const page = await context.newPage()
  try {
    if (opts.manualLogin) {
      await manualSignIn(page, opts.baseUrl)
    } else {
      await signIn(page, opts.baseUrl, opts.username, opts.password, opts.auth)
    }
    await context.storageState({ path: statePath })
    return { authDir, statePath }
  } catch (err) {
    // Describe the page BEFORE the browser goes away — this is the one moment
    // the evidence exists.
    err.pageReport = await describeSignInPage(page, REPORT_DIR).catch(
      () => null
    )
    throw err
  } finally {
    await browser.close()
  }
}

/**
 * Hold the windows open at the end.
 *
 * Nothing to wait for when there is nothing to look at, so headless runs skip
 * it entirely rather than sleeping for no reason.
 */
async function lingerBeforeClosing(opts) {
  if (opts.headless) {
    return
  }
  if (opts.keepOpen) {
    info('')
    await waitForEnter('Windows left open. Press Enter to close them... ')
    return
  }
  if (opts.lingerSeconds > 0) {
    info('')
    info(
      color(
        'grey',
        `  closing the windows in ${opts.lingerSeconds}s ` +
          '(--linger to change, --keep-open to wait for Enter)'
      )
    )
    await new Promise((resolve) =>
      setTimeout(resolve, opts.lingerSeconds * MS_PER_SECOND)
    )
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
    if (err.pageReport) {
      info('')
      info(color('yellow', '  What the sign-in page actually was:'))
      info(color('grey', err.pageReport))
    }
    info('')
    info(
      color(
        'grey',
        '  --show-login runs the scripted sign-in in a visible window.\n' +
          '  --manual-login lets you sign in by hand once, which works whatever\n' +
          '  the provider asks for.\n' +
          '  --auth forces a provider if detection picked the wrong one.'
      )
    )
    return 1
  }

  // Every window starts from the IdP cookies ONLY, so each one signs itself in
  // and gets a session of its own. Sharing the service's session cookie is what
  // made two concurrent uploads clobber each other's pendingUploadId.
  let windowState = session.statePath
  if (!opts.shareSession) {
    const stripped = await stripServiceCookies(
      session.statePath,
      opts.baseUrl,
      path.join(session.authDir, 'idp-only.json')
    )
    windowState = stripped.path
    info(
      color(
        'grey',
        `  ${stripped.dropped} service cookie(s) dropped, ` +
          `${stripped.kept} identity-provider cookie(s) kept`
      )
    )
  }

  info('')
  info(`> opening ${opts.count} window(s) and staging the upload in each`)
  const stamp = Date.now()
  const windows = await Promise.all(
    layout.cells.map((cell) =>
      openWindow(cell, {
        headless: opts.headless,
        storageState: windowState,
        baseUrl: opts.baseUrl,
        actionTimeout: opts.actionTimeout
      })
    )
  )

  // Recording starts before the journey does, so sign-in, project creation and
  // the upload are all in the log when something goes wrong later.
  const tracked = windows.map((win, i) => ({
    win,
    label: `#${i + 1}`,
    network: recordNetwork(win.page, opts.baseUrl)
  }))

  // Sessions ONE AT A TIME. Every window authorises against the same IdP
  // session — that is the whole point of reusing its cookies — and an identity
  // provider treats one session starting several authorisations at once as the
  // attack it looks like: GOV.UK One Login answers the second with
  // "interaction session and authentication session mismatch". Serialising
  // costs a redirect each and nothing else, because SSO answers them without
  // asking anything. Only the UPLOADS have to be simultaneous.
  const sessionFailures = new Map()
  if (!opts.shareSession) {
    for (const item of tracked) {
      try {
        await establishOwnSession(item.win.page, opts.baseUrl)
      } catch (err) {
        sessionFailures.set(item.label, err.message)
        fail(`  ${item.label} could not get its own session: ${err.message}`)
      }
    }
  }

  const staged = await Promise.all(
    tracked.map(async ({ win, label, network }) => {
      if (sessionFailures.has(label)) {
        return {
          label,
          win,
          network,
          ready: false,
          detail: sessionFailures.get(label)
        }
      }
      try {
        const projectId = await stageUpload(
          win.page,
          opts.baseUrl,
          opts.filePath,
          `Burst ${stamp} ${label}`
        )
        info(color('grey', `  ${label} ready - project ${projectId}`))
        return { label, projectId, win, network, ready: true }
      } catch (err) {
        fail(`  ${label} could not be staged: ${err.message}`)
        return { label, win, network, ready: false, detail: err.message }
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
        // noWaitAfter: the click is the moment of submission; what follows is
        // the service's business and awaitOutcome's to watch. Waiting here for
        // "scheduled navigations to finish" put a 30 s cap on an upload that
        // legitimately takes longer — eight large files leaving one machine at
        // once — and reported a click timeout for a click that had worked.
        await s.win.page
          .getByRole('button', { name: 'Continue' })
          .click({ noWaitAfter: true })
        const result = await awaitOutcome(
          s.win.page,
          s.projectId,
          opts.outcomeTimeout
        )
        const row = {
          label: s.label,
          projectId: s.projectId,
          outcome: result.outcome,
          detail: result.detail,
          elapsedMs: Date.now() - firedAt
        }
        // Evidence for anything that did not simply work, gathered while the
        // browser is still open — afterwards there is nothing left to ask.
        if (result.outcome !== 'validated') {
          row.evidence = await saveWindowEvidence(
            s.win.page,
            s.label,
            s.network,
            result
          ).catch(() => null)
        }
        return row
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

  await lingerBeforeClosing(opts)

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
