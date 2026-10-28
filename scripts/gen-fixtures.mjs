/**
 * (Re)generate the committed GeoPackage fixtures in fixtures/.
 *
 * The upload fixtures are committed rather than generated on every run:
 * generation is super-linear in parcel count (xlarge alone costs ~30s in the
 * CDP container), and a committed file is also a stable artefact anyone can
 * grab for an ad-hoc upload test against any environment. Generation is
 * seeded (scripts/make-gpkg.mjs), so re-running this produces byte-identical
 * files for the same bng-library pin — a diff here means the generator
 * changed, not chance.
 *
 * There is one set per upload template, the same four sizes in each:
 *   baseline-<size>.gpkg  the legacy (Natural England) baseline, for a run
 *                         against a service with the service-template flag off
 *   template-<size>.gpkg  the BNG Service template, one file holding both
 *                         stages, for a run with the flag on
 * Each manifest entry names its `template` (legacy | service), so a reader
 * picks the set the run is for. The legacy set goes when the legacy template
 * is decommissioned (BMD-1097).
 *
 * stage-uploads.mjs matches each requested size against fixtures/manifest.json
 * by template, label AND parcel count, and falls back to generating at run
 * time when they differ — so UPLOAD_SIZES still works with any parcel count;
 * only the defaults below get the committed fast path.
 *
 * Run after changing a size or bumping the bng-library pin:
 *   npm run gen-fixtures
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeGeoPackage, makeTemplateGeoPackage } from './make-gpkg.mjs'

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures')

/**
 * The default sizes of the run's upload profile — keep in step with
 * DEFAULT_SIZES in stage-uploads.mjs (a mismatch is safe but forfeits the
 * committed fast path for the mismatched size).
 */
const SIZES = [
  { label: 'normal', parcels: 80 },
  { label: 'medium', parcels: 800 },
  { label: 'large', parcels: 5000 },
  { label: 'xlarge', parcels: 12000 }
]

const TEMPLATES = [
  { template: 'legacy', prefix: 'baseline', make: makeGeoPackage },
  { template: 'service', prefix: 'template', make: makeTemplateGeoPackage }
]

mkdirSync(FIXTURES_DIR, { recursive: true })

const entries = []
for (const { template, prefix, make } of TEMPLATES) {
  for (const { label, parcels } of SIZES) {
    const file = `${prefix}-${label}.gpkg`
    const { bytes, generationMs } = make(join(FIXTURES_DIR, file), parcels)
    entries.push({ template, label, parcels, file, bytes })
    process.stderr.write(
      `▸ ${template} ${label}: ${parcels} parcels → ${file}, ${(bytes / 1024).toFixed(0)} KB ` +
        `(${(generationMs / 1000).toFixed(1)}s)\n`
    )
  }
}

writeFileSync(
  join(FIXTURES_DIR, 'manifest.json'),
  JSON.stringify({ sizes: entries }, null, 2) + '\n'
)
process.stderr.write(`▸ wrote ${join(FIXTURES_DIR, 'manifest.json')}\n`)
