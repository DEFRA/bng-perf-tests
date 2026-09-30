/**
 * The parts of the watch-a-burst tool that decide things before a browser is
 * ever launched: how many windows are allowed, where they go on the screen, and
 * which GeoPackage gets uploaded.
 *
 * The browser half is not covered here — it needs a Chromium download and a
 * live service. What is covered is everything that can send a run wrong before
 * either exists, plus the cap, which is a promise about what this tool will
 * refuse to do.
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import path from 'node:path'

import {
  AUTH_PROVIDERS,
  HELP,
  MAX_WINDOWS,
  classifyMessage,
  parseArgs,
  parseCols,
  parseCount,
  parseNonNegative,
  parseScreen,
  readSizes,
  resolveUploadFile,
  tile
} from '../scripts/concurrent-uploads.mjs'

const SCREEN = { width: 1920, height: 1080 }

describe('parseCount — the window cap', () => {
  test('defaults when nothing is asked for', () => {
    assert.equal(parseCount(undefined), 4)
  })

  test('accepts a count up to the cap', () => {
    assert.equal(parseCount(String(MAX_WINDOWS)), MAX_WINDOWS)
  })

  test('refuses one past the cap', () => {
    assert.throws(() => parseCount(String(MAX_WINDOWS + 1)), /capped at 12/)
  })

  test('refuses a wildly larger count', () => {
    assert.throws(() => parseCount('100'), /capped at 12/)
  })

  test('the cap is a refusal, not a clamp', () => {
    // Silently running 12 when 50 was asked for would make the tool report on a
    // burst nobody requested. Better to stop and say so.
    assert.throws(() => parseCount('50'))
  })

  test('refuses zero, negatives and nonsense', () => {
    for (const bad of ['0', '-3', 'lots', '2.5']) {
      assert.throws(() => parseCount(bad), /positive integer/, `for "${bad}"`)
    }
  })
})

describe('tile — laying windows out', () => {
  test('four windows make a 2x2', () => {
    const { cols, rows, cells } = tile(4, SCREEN, undefined)
    assert.equal(cols, 2)
    assert.equal(rows, 2)
    assert.equal(cells.length, 4)
  })

  test('nine windows make a 3x3', () => {
    const { cols, rows } = tile(9, SCREEN, undefined)
    assert.equal(cols, 3)
    assert.equal(rows, 3)
  })

  test('a ragged count still gets a cell each', () => {
    const { cols, rows, cells } = tile(5, SCREEN, undefined)
    assert.equal(cols, 3)
    assert.equal(rows, 2)
    assert.equal(cells.length, 5)
  })

  test('windows in a row sit side by side, not on top of each other', () => {
    const { cells, width } = tile(4, SCREEN, undefined)
    assert.equal(cells[0].x, 0)
    assert.equal(cells[1].x, cells[0].x + width)
  })

  test('the second row is below the first', () => {
    const { cells } = tile(4, SCREEN, undefined)
    assert.ok(cells[2].y > cells[0].y)
  })

  test('every window stays on the screen, at every size up to the cap', () => {
    for (let n = 1; n <= MAX_WINDOWS; n++) {
      for (const cell of tile(n, SCREEN, undefined).cells) {
        assert.ok(
          cell.x + cell.width <= SCREEN.width,
          `window overflows right at count ${n}`
        )
        assert.ok(
          cell.y + cell.height <= SCREEN.height,
          `window overflows bottom at count ${n}`
        )
      }
    }
  })

  test('--cols is honoured', () => {
    const { cols, rows } = tile(6, SCREEN, 6)
    assert.equal(cols, 6)
    assert.equal(rows, 1)
  })

  test('--cols cannot exceed the number of windows', () => {
    assert.equal(tile(2, SCREEN, 10).cols, 2)
  })
})

describe('parseScreen', () => {
  test('reads a WxH override', () => {
    assert.deepEqual(parseScreen('3440x1440'), { width: 3440, height: 1440 })
  })

  test('no override means detect it instead', () => {
    assert.equal(parseScreen(undefined), null)
  })

  test('rejects anything that is not WxH', () => {
    assert.throws(() => parseScreen('huge'), /1920x1080/)
  })
})

describe('resolveUploadFile — which GeoPackage gets sent', () => {
  test('defaults to a size from the suite ladder', async () => {
    const file = await resolveUploadFile({})
    assert.match(file, /baseline-large\.gpkg$/)
  })

  test('every label in the manifest resolves to a fixture', async () => {
    for (const { label, file } of await readSizes()) {
      const resolved = await resolveUploadFile({ size: label })
      assert.equal(path.basename(resolved), file)
    }
  })

  test('xlarge is the 12,000-parcel file the burst is usually about', async () => {
    const sizes = await readSizes()
    const xlarge = sizes.find((entry) => entry.label === 'xlarge')
    assert.equal(xlarge.parcels, 12000)
  })

  test('an unknown size lists the ones that exist', async () => {
    await assert.rejects(() => resolveUploadFile({ size: 'enormous' }), /normal/)
  })

  test('an explicit --file wins over the ladder', async () => {
    const resolved = await resolveUploadFile({ file: '/tmp/mine.gpkg' })
    assert.equal(resolved, '/tmp/mine.gpkg')
  })
})

describe('parseArgs', () => {
  test('reads flags and values', () => {
    const args = parseArgs(['--url', 'http://x', '--count', '3', '--headless'])
    assert.equal(args.url, 'http://x')
    assert.equal(args.count, '3')
    assert.equal(args.headless, true)
  })

  test('a value-taking option with no value is an error, not a silent undefined', () => {
    assert.throws(() => parseArgs(['--url']), /needs a value/)
  })

  test('a stray positional is an error rather than being ignored', () => {
    assert.throws(() => parseArgs(['banana']), /Unexpected argument/)
  })

  test('an unknown option names ITSELF, not the argument after it', () => {
    // The failure this prevents: an unrecognised option used to be treated as
    // value-taking, so it swallowed the next option and the error pointed at
    // that option's value instead — "Unexpected argument \"normal\"" for a
    // command whose real problem was --show-login three arguments earlier.
    assert.throws(
      () => parseArgs(['--show-login-typo', '--size', 'normal']),
      /Unknown option "--show-login-typo"/
    )
  })

  test('a known flag does not swallow the option after it', () => {
    const args = parseArgs(['--show-login', '--size', 'normal', '--count', '2'])
    assert.equal(args['show-login'], true)
    assert.equal(args.size, 'normal')
    assert.equal(args.count, '2')
  })

  test('every option named in --help is recognised', () => {
    // Read from the help text itself, so an option added there without a
    // parser entry (or the reverse) fails here instead of drifting silently.
    // A `<placeholder>` after the name marks it as taking a value.
    const options = [...HELP.matchAll(/^ {2}(--[a-z-]+)( <[^>]+>)?/gm)]
    assert.ok(options.length > 10, 'the help text should list the options')
    for (const [, opt, placeholder] of options) {
      const key = opt.replace(/^--/, '')
      if (placeholder) {
        assert.equal(parseArgs([opt, '1'])[key], '1', opt)
      } else {
        assert.equal(parseArgs([opt])[key], true, opt)
      }
    }
  })

  test('the options the help list is known to include', () => {
    for (const opt of ['--share-session', '--linger', '--action-timeout']) {
      assert.match(HELP, new RegExp(`^ {2}${opt}\\b`, 'm'), opt)
    }
  })
})

describe('sign-in options', () => {
  test('--manual-login is a flag, not a value-taking option', () => {
    const args = parseArgs(['--manual-login', '--url', 'http://x'])
    assert.equal(args['manual-login'], true)
    assert.equal(args.url, 'http://x')
  })

  test('the providers it knows how to drive', () => {
    // One Login and Government Gateway are different services with different
    // first screens; `auto` exists because which one answers is a per-
    // environment OIDC_DISCOVERY_URL this code cannot read.
    assert.deepEqual(AUTH_PROVIDERS, [
      'auto',
      'one-login',
      'government-gateway'
    ])
  })

  test('--auth takes a value', () => {
    assert.equal(parseArgs(['--auth', 'one-login']).auth, 'one-login')
  })
})

describe('how long the windows stay up', () => {
  test('--linger takes a value', () => {
    assert.equal(parseArgs(['--linger', '30']).linger, '30')
  })

  test('--linger 0 is a legitimate choice, not a missing value', () => {
    // Number('0') is falsy, so anything reading this with ?? or || instead of
    // an explicit undefined check would silently restore the default.
    const args = parseArgs(['--linger', '0'])
    assert.equal(args.linger, '0')
    assert.equal(Number(args.linger ?? 10), 0)
  })

  test('--keep-open remains a flag alongside it', () => {
    const args = parseArgs(['--keep-open', '--linger', '5'])
    assert.equal(args['keep-open'], true)
    assert.equal(args.linger, '5')
  })
})

describe('numeric options refuse what is not a number', () => {
  test('a missing value takes the default', () => {
    assert.equal(parseNonNegative('--timeout', undefined, 150_000), 150_000)
  })

  test('zero and plain numbers are accepted', () => {
    assert.equal(parseNonNegative('--linger', '0', 10), 0)
    assert.equal(parseNonNegative('--stagger', '250', 0), 250)
    assert.equal(parseNonNegative('--timeout', '1.5e5', 0), 150_000)
  })

  test('a unit, a negative or nothing at all is refused, naming the flag', () => {
    for (const bad of ['150s', '10s', '-1', '', 'abc', 'Infinity']) {
      assert.throws(
        () => parseNonNegative('--timeout', bad, 0),
        /--timeout must be a non-negative number/,
        `for "${bad}"`
      )
    }
  })

  test('--cols is a positive integer or the default layout', () => {
    assert.equal(parseCols(undefined), undefined)
    assert.equal(parseCols('3'), 3)
    for (const bad of ['0', '-2', '1.5', 'three', '']) {
      assert.throws(() => parseCols(bad), /--cols must be a positive integer/)
    }
  })
})

describe('classifyMessage — what the upload form said', () => {
  test('the busy message is busy, even though it says try again', () => {
    assert.equal(
      classifyMessage(
        'The service is busy checking other files. Please try again in a few moments.'
      ),
      'busy'
    )
  })

  test('the frontend giving up is gave up', () => {
    assert.equal(
      classifyMessage('The file check timed out. Please try again.'),
      'gave up'
    )
  })

  test('busy wins if a message ever says both', () => {
    assert.equal(
      classifyMessage('The service is busy and the file check timed out'),
      'busy'
    )
  })

  test('anything else is returned, for a person to read', () => {
    assert.equal(classifyMessage('The selected file must be a .gpkg'), 'returned')
    assert.equal(classifyMessage(''), 'returned')
  })
})
