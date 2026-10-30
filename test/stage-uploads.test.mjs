/**
 * The pure half of staging: what it will accept as a pool spec, and which
 * features it considers safe to edit repeatedly.
 *
 * The network half is not covered here — it needs a live backend, an uploader
 * and a virus scanner. What is covered is the part that decides, silently and
 * before any of that, whether a phase gets a pool at all.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, describe } from 'node:test'

import {
  describeError,
  editableHabitats,
  formatMismatchMessage,
  isNetworkError,
  manifestEntry,
  parsePreparedSizes,
  parseUploadTemplate,
  stagedPostInterventionUploadId,
  stagedSize,
  validateEndpointFor
} from '../scripts/stage-uploads.mjs'

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'fixtures', 'manifest.json'))
)

describe('parseUploadTemplate', () => {
  test('defaults to the legacy template, so an existing run is unchanged', () => {
    // entrypoint.sh passes UPLOAD_TEMPLATE whether or not it was set.
    assert.equal(parseUploadTemplate(undefined), 'legacy')
    assert.equal(parseUploadTemplate(''), 'legacy')
  })

  test('reads either template, whatever the case', () => {
    assert.equal(parseUploadTemplate('legacy'), 'legacy')
    assert.equal(parseUploadTemplate(' Service '), 'service')
  })

  test('rejects anything else loudly', () => {
    // A mistyped value would stage the wrong file and have every validate
    // refused at the format gate.
    assert.throws(() => parseUploadTemplate('bng-service'), /UPLOAD_TEMPLATE/)
    assert.throws(() => parseUploadTemplate('true'), /UPLOAD_TEMPLATE/)
  })
})

describe('manifestEntry', () => {
  test('the committed manifest has all four sizes in both templates', () => {
    for (const template of ['legacy', 'service']) {
      for (const [label, parcels] of [
        ['normal', 80],
        ['medium', 800],
        ['large', 5000],
        ['xlarge', 12000]
      ]) {
        const entry = manifestEntry(MANIFEST, { template, label, parcels })
        assert.ok(entry, `${template} ${label} is in fixtures/manifest.json`)
        assert.match(
          entry.file,
          new RegExp(`^${template === 'service' ? 'template' : 'baseline'}-${label}\\.gpkg$`)
        )
      }
    }
  })

  test('never hands one template the other template’s file', () => {
    const manifest = {
      sizes: [{ template: 'legacy', label: 'normal', parcels: 80, file: 'baseline-normal.gpkg' }]
    }
    assert.equal(
      manifestEntry(manifest, { template: 'service', label: 'normal', parcels: 80 }),
      null
    )
  })

  test('an entry without a template is legacy, as every entry was before', () => {
    const manifest = { sizes: [{ label: 'normal', parcels: 80, file: 'baseline-normal.gpkg' }] }
    assert.ok(manifestEntry(manifest, { template: 'legacy', label: 'normal', parcels: 80 }))
    assert.equal(
      manifestEntry(manifest, { template: 'service', label: 'normal', parcels: 80 }),
      null
    )
  })

  test('a changed parcel count falls back to generating', () => {
    assert.equal(
      manifestEntry(MANIFEST, { template: 'service', label: 'normal', parcels: 81 }),
      null
    )
  })
})

describe('validateEndpointFor', () => {
  test('a template file loads through the single-file upload endpoint', () => {
    // The post-intervention endpoint stores both of a template file's stages.
    assert.equal(validateEndpointFor('service'), '/post-intervention/validate')
    assert.equal(validateEndpointFor('legacy'), '/baseline/validate')
  })
})

describe('the post-intervention ladder replays the staged upload', () => {
  test('a template size reuses its own upload', () => {
    const size = stagedSize({
      template: 'service',
      label: 'normal',
      parcels: 80,
      bytes: 1,
      uploadId: 'upload-1'
    })
    assert.equal(size.template, 'service')
    assert.equal(stagedPostInterventionUploadId(size), 'upload-1')
  })

  test('a legacy size, and a size that lost its template, stages a pair', () => {
    // Losing the template is what made a template run generate a legacy
    // post-intervention file and measure the flag refusing it.
    assert.equal(
      stagedPostInterventionUploadId(
        stagedSize({
          template: 'legacy',
          label: 'normal',
          parcels: 80,
          bytes: 1,
          uploadId: 'upload-1'
        })
      ),
      null
    )
    assert.equal(
      stagedPostInterventionUploadId({ label: 'normal', uploadId: 'upload-1' }),
      null
    )
  })
})

describe('formatMismatchMessage', () => {
  test('a pass is not a mismatch', () => {
    assert.equal(formatMismatchMessage('service', { valid: true, errors: [] }), null)
  })

  test('a refused template upload names the flag value the run needs', () => {
    const message = formatMismatchMessage('service', {
      valid: false,
      errors: [{ code: 'GPKG_MISSING_LAYER' }, { code: 'GPKG_MISSING_LAYER' }]
    })
    assert.match(message, /GPKG_MISSING_LAYER\)/)
    assert.match(message, /SERVICE_TEMPLATE_ENABLED=true/)
  })

  test('a refused legacy upload names the flag value the run needs', () => {
    const message = formatMismatchMessage('legacy', {
      valid: false,
      errors: [{ code: 'LEGACY_TEMPLATE_NOT_ACCEPTED' }]
    })
    assert.match(message, /LEGACY_TEMPLATE_NOT_ACCEPTED/)
    assert.match(message, /SERVICE_TEMPLATE_ENABLED=false/)
  })
})

describe('a failed fetch', () => {
  const networkError = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
    })

  test('is reported with its cause, not as a bare "fetch failed"', () => {
    // The large post-intervention upload once failed to stage with nothing
    // more in the log than "fetch failed".
    assert.equal(
      describeError(networkError()),
      'fetch failed (UND_ERR_SOCKET other side closed)'
    )
    assert.equal(describeError(new Error('POST x -> 500: boom')), 'POST x -> 500: boom')
  })

  test('is retried only when the service never answered', () => {
    assert.equal(isNetworkError(networkError()), true)
    // An error status is the service's answer; retrying would hide it.
    assert.equal(isNetworkError(new Error('POST x -> 500: boom')), false)
    assert.equal(isNetworkError(new TypeError('x is not a function')), false)
  })
})

describe('parsePreparedSizes', () => {
  test('reads label:count pairs', () => {
    assert.deepEqual(parsePreparedSizes('normal:10,large:5'), [
      { label: 'normal', count: 10 },
      { label: 'large', count: 5 }
    ])
  })

  test('an empty spec asks for nothing rather than erroring', () => {
    // entrypoint.sh passes this on the command line whether or not any phase
    // needs a pool, so an empty string is the normal "no pools" case.
    assert.deepEqual(parsePreparedSizes(''), [])
    assert.deepEqual(parsePreparedSizes(undefined), [])
  })

  test('tolerates whitespace and trailing separators', () => {
    assert.deepEqual(parsePreparedSizes(' normal:2 , '), [
      { label: 'normal', count: 2 }
    ])
  })

  test('rejects a bad entry loudly instead of dropping it', () => {
    // A silently dropped entry leaves a phase with no pool and no explanation
    // anywhere — the failure mode this whole file exists to avoid.
    assert.throws(() => parsePreparedSizes('normal'), /bad count/)
    assert.throws(() => parsePreparedSizes('normal:0'), /bad count/)
    assert.throws(() => parsePreparedSizes('normal:-1'), /bad count/)
    assert.throws(() => parsePreparedSizes('normal:2.5'), /bad count/)
    assert.throws(() => parsePreparedSizes('Normal:2'), /bad label/)
    assert.throws(() => parsePreparedSizes('every day:2'), /bad label/)
  })
})

describe('editableHabitats', () => {
  const complete = {
    featureId: '11111111-1111-1111-1111-111111111111',
    ref: 'A1',
    broadType: 'Grassland',
    type: 'Other neutral grassland',
    condition: 'Moderate'
  }

  test('maps a feature to the shape the PUT sends', () => {
    // The route takes habitatType; the document stores it as `type`.
    assert.deepEqual(editableHabitats({ baseline: { habitats: [complete] } }), [
      {
        featureId: complete.featureId,
        broadType: 'Grassland',
        habitatType: 'Other neutral grassland',
        condition: 'Moderate'
      }
    ])
  })

  test('excludes a feature missing any attribute the edit writes back', () => {
    // The edit writes the feature's own values back — a missing one would send
    // a blank, which normalizeEdits turns into a null. That is a different edit
    // from the no-op this is meant to be, and it would drift the document over
    // a run rather than measuring the same write repeatedly.
    const habitats = [
      complete,
      { ...complete, featureId: 'b', condition: null },
      { ...complete, featureId: 'c', broadType: '' },
      { ...complete, featureId: 'd', type: undefined },
      { ...complete, featureId: undefined }
    ]
    const ids = editableHabitats({ baseline: { habitats } }).map((f) => f.featureId)
    assert.deepEqual(ids, [complete.featureId])
  })

  test('an empty or absent document yields nothing rather than throwing', () => {
    // A project whose baseline never validated has no habitats key at all, and
    // staging has to report "no pool" rather than crash the whole run.
    assert.deepEqual(editableHabitats(undefined), [])
    assert.deepEqual(editableHabitats({}), [])
    assert.deepEqual(editableHabitats({ baseline: {} }), [])
    assert.deepEqual(editableHabitats({ baseline: { habitats: [] } }), [])
  })

  test('only looks at the baseline, not the post-intervention document', () => {
    // The edit ladder PUTs to /projects/{id}/habitats/{featureId}, which is the
    // baseline route; a post-intervention feature would 404 there.
    const project = {
      baseline: { habitats: [complete] },
      postIntervention: { habitats: [{ ...complete, featureId: 'pi' }] }
    }
    const ids = editableHabitats(project).map((f) => f.featureId)
    assert.deepEqual(ids, [complete.featureId])
  })
})
