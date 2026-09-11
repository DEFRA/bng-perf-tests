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
  MAX_WINDOWS,
  parseArgs,
  parseCount,
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
})
