/**
 * Build a valid BNG baseline GeoPackage of an arbitrary size.
 *
 * The upload scenarios need files that get all the way through validation —
 * a file rejected at the format gate exits before the expensive work and would
 * measure nothing. So this generates something the backend accepts end to end:
 *
 *   - the two required layers (Habitats, Red Line Boundary), columns exactly as
 *     `gpkg-template.schema.json` declares them
 *   - real British National Grid coordinates inside England, because the
 *     geometry checks test containment against an England boundary
 *   - habitat parcels on a non-overlapping grid, wholly inside the red line,
 *     each above the sliver threshold and carrying a unique parcel ref
 *   - an in-scope habitat type ("Cropland - Cereal crops", Low distinctiveness);
 *     High and V.High are out of scope and would be rejected
 *
 * Generated rather than committed so any size can be asked for without putting
 * tens of MB of binaries in git. Uses node:sqlite so the container needs no
 * native module — the base image ships Node 22, which has it built in.
 */
import { DatabaseSync } from 'node:sqlite'
import { rmSync, statSync } from 'node:fs'

// GeoPackage application_id "GP10" — the identifier the format gate checks for.
const GPKG_APPLICATION_ID = 0x47503130
const EPSG_BNG = 27700

// A patch of open country near Cambridge, comfortably inside England so the
// containment check passes. Metres, British National Grid.
const ORIGIN_EASTING = 545000
const ORIGIN_NORTHING = 258000

// Each parcel is a PARCEL_SIZE_M square with a gap, so no two touch (the
// overlap check) and each is far above the sliver threshold.
const PARCEL_SIZE_M = 40
const PARCEL_GAP_M = 10
const PARCEL_PITCH_M = PARCEL_SIZE_M + PARCEL_GAP_M
const RED_LINE_MARGIN_M = 100

// In-scope habitat (Low distinctiveness). High / V.High are out of scope and
// would trip HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE before the geometry checks.
const BROAD_HABITAT = 'Cropland'
const HABITAT_TYPE = 'Cereal crops'
const CONDITION = 'Moderate'
const STRATEGIC_SIGNIFICANCE =
  'Location ecologically desirable but not in local strategy'

const WKB_LITTLE_ENDIAN = 1
const WKB_POLYGON = 3
const WKB_MULTIPOLYGON = 6
const GPKG_ENVELOPE_NONE = 0
const DOUBLE_BYTES = 8
const RING_POINTS = 5

/** GeoPackage binary header: magic "GP", version, flags, then the srs id. */
function gpkgHeader(srsId) {
  const header = Buffer.alloc(8)
  header.write('GP', 0, 'ascii')
  header.writeUInt8(0, 2) // version
  // bit 0 = little endian byte order; envelope indicator 0 = no envelope
  header.writeUInt8(WKB_LITTLE_ENDIAN | (GPKG_ENVELOPE_NONE << 1), 3)
  header.writeInt32LE(srsId, 4)
  return header
}

/** WKB for a closed ring of points, as the body of a polygon. */
function ringBytes(points) {
  const buf = Buffer.alloc(4 + points.length * 2 * DOUBLE_BYTES)
  buf.writeUInt32LE(points.length, 0)
  let at = 4
  for (const [x, y] of points) {
    buf.writeDoubleLE(x, at)
    buf.writeDoubleLE(y, at + DOUBLE_BYTES)
    at += 2 * DOUBLE_BYTES
  }
  return buf
}

function squareRing(minX, minY, size) {
  const maxX = minX + size
  const maxY = minY + size
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY]
  ]
}

/** A GeoPackage POLYGON blob for one square. */
function polygonBlob(minX, minY, size) {
  const prefix = Buffer.alloc(9)
  prefix.writeUInt8(WKB_LITTLE_ENDIAN, 0)
  prefix.writeUInt32LE(WKB_POLYGON, 1)
  prefix.writeUInt32LE(1, 5) // one ring
  return Buffer.concat([
    gpkgHeader(EPSG_BNG),
    prefix,
    ringBytes(squareRing(minX, minY, size))
  ])
}

/** A GeoPackage MULTIPOLYGON blob holding one square — the Habitats geometry. */
function multiPolygonBlob(minX, minY, size) {
  const outer = Buffer.alloc(9)
  outer.writeUInt8(WKB_LITTLE_ENDIAN, 0)
  outer.writeUInt32LE(WKB_MULTIPOLYGON, 1)
  outer.writeUInt32LE(1, 5) // one polygon
  const inner = Buffer.alloc(9)
  inner.writeUInt8(WKB_LITTLE_ENDIAN, 0)
  inner.writeUInt32LE(WKB_POLYGON, 1)
  inner.writeUInt32LE(1, 5) // one ring
  return Buffer.concat([
    gpkgHeader(EPSG_BNG),
    outer,
    inner,
    ringBytes(squareRing(minX, minY, size))
  ])
}

function createSystemTables(db) {
  db.exec(`
    CREATE TABLE gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT NOT NULL,
      organization_coordsys_id INTEGER NOT NULL,
      definition TEXT NOT NULL,
      description TEXT
    );
    CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY,
      data_type TEXT NOT NULL,
      identifier TEXT UNIQUE,
      description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
      srs_id INTEGER
    );
    CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      geometry_type_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL,
      z TINYINT NOT NULL,
      m TINYINT NOT NULL,
      CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name)
    );
  `)
  db.prepare(
    `INSERT INTO gpkg_spatial_ref_sys
       (srs_name, srs_id, organization, organization_coordsys_id, definition)
     VALUES (?, ?, 'EPSG', ?, 'undefined')`
  ).run('British National Grid', EPSG_BNG, EPSG_BNG)
}

const HABITAT_COLUMNS = [
  ['Parcel Ref', 'TEXT'],
  ['Baseline Broad Habitat Type', 'TEXT'],
  ['Baseline Habitat Type', 'TEXT'],
  ['Area', 'MEDIUMINT'],
  ['Baseline Condition', 'TEXT'],
  ['Baseline Strategic Significance', 'TEXT'],
  ['Retention Category', 'TEXT'],
  ['Proposed Broad Habitat Type', 'TEXT'],
  ['Proposed Habitat Type', 'TEXT'],
  ['Proposed Condition', 'TEXT'],
  ['Proposed Strategic Significance', 'TEXT'],
  ['Habitat created in advance/years', 'TEXT'],
  ['Delay in starting habitat creation/years', 'TEXT'],
  ['Spatial risk category', 'TEXT'],
  ['Location', 'TEXT'],
  ['Site Name', 'TEXT'],
  ['Survey Date', 'DATE'],
  ['Survey Details', 'TEXT'],
  ['Comment', 'TEXT'],
  ['Mapped by', 'TEXT'],
  ['Company', 'TEXT'],
  ['Base Map', 'TEXT'],
  ['Baseline Distinctiveness', 'TEXT'],
  ['Proposed Distinctiveness', 'TEXT']
]

function registerLayer(db, tableName, geomColumn, geometryType, bounds) {
  db.prepare(
    `INSERT INTO gpkg_contents
       (table_name, data_type, identifier, srs_id, min_x, min_y, max_x, max_y)
     VALUES (?, 'features', ?, ?, ?, ?, ?, ?)`
  ).run(
    tableName,
    tableName,
    EPSG_BNG,
    bounds.minX,
    bounds.minY,
    bounds.maxX,
    bounds.maxY
  )
  db.prepare(
    `INSERT INTO gpkg_geometry_columns
       (table_name, column_name, geometry_type_name, srs_id, z, m)
     VALUES (?, ?, ?, ?, 0, 0)`
  ).run(tableName, geomColumn, geometryType, EPSG_BNG)
}

/** Grid dimensions that hold `parcels` squares in as square a block as possible. */
function gridFor(parcels) {
  const perRow = Math.max(1, Math.ceil(Math.sqrt(parcels)))
  return { perRow, rows: Math.ceil(parcels / perRow) }
}

function createHabitats(db, parcels, bounds) {
  const columnDdl = HABITAT_COLUMNS.map(
    ([name, type]) => `"${name}" ${type}`
  ).join(', ')
  db.exec(
    `CREATE TABLE "Habitats" (fid INTEGER NOT NULL PRIMARY KEY, geom MULTIPOLYGON, ${columnDdl})`
  )
  registerLayer(db, 'Habitats', 'geom', 'MULTIPOLYGON', bounds)

  const names = HABITAT_COLUMNS.map(([name]) => `"${name}"`).join(', ')
  const placeholders = HABITAT_COLUMNS.map(() => '?').join(', ')
  const insert = db.prepare(
    `INSERT INTO "Habitats" (geom, ${names}) VALUES (?, ${placeholders})`
  )
  const areaSquareMetres = PARCEL_SIZE_M * PARCEL_SIZE_M
  const { perRow } = gridFor(parcels)

  db.exec('BEGIN')
  for (let i = 0; i < parcels; i++) {
    const minX = ORIGIN_EASTING + (i % perRow) * PARCEL_PITCH_M
    const minY = ORIGIN_NORTHING + Math.floor(i / perRow) * PARCEL_PITCH_M
    insert.run(
      multiPolygonBlob(minX, minY, PARCEL_SIZE_M),
      `PERF-${i + 1}`,
      BROAD_HABITAT,
      HABITAT_TYPE,
      areaSquareMetres,
      CONDITION,
      STRATEGIC_SIGNIFICANCE,
      null, // Retention Category
      null, // Proposed Broad Habitat Type
      null, // Proposed Habitat Type
      null, // Proposed Condition
      null, // Proposed Strategic Significance
      null, // Habitat created in advance/years — leaving both null keeps the
      null, // Delay …                            advance/delay check happy
      null, // Spatial risk category
      null, // Location
      'BNG perf test site',
      '2026-01-01',
      null, // Survey Details
      null, // Comment
      'perf-tests',
      null, // Company
      null, // Base Map
      null, // Baseline Distinctiveness
      null // Proposed Distinctiveness
    )
  }
  db.exec('COMMIT')
}

function createRedLineBoundary(db, bounds) {
  db.exec(
    `CREATE TABLE "Red Line Boundary" (
       fid INTEGER NOT NULL PRIMARY KEY,
       geometry POLYGON,
       "Area" REAL,
       "Site Name" TEXT
     )`
  )
  registerLayer(db, 'Red Line Boundary', 'geometry', 'POLYGON', bounds)
  const width = bounds.maxX - bounds.minX
  db.prepare(
    `INSERT INTO "Red Line Boundary" (geometry, "Area", "Site Name")
     VALUES (?, ?, ?)`
  ).run(
    polygonBlob(bounds.minX, bounds.minY, width),
    width * (bounds.maxY - bounds.minY),
    'BNG perf test site'
  )
}

/**
 * A red line that encloses the whole parcel grid with a margin, kept square so
 * one polygon covers it.
 */
function boundsFor(parcels) {
  const { perRow, rows } = gridFor(parcels)
  const span =
    Math.max(perRow, rows) * PARCEL_PITCH_M + RED_LINE_MARGIN_M * 2
  return {
    minX: ORIGIN_EASTING - RED_LINE_MARGIN_M,
    minY: ORIGIN_NORTHING - RED_LINE_MARGIN_M,
    maxX: ORIGIN_EASTING - RED_LINE_MARGIN_M + span,
    maxY: ORIGIN_NORTHING - RED_LINE_MARGIN_M + span
  }
}

/**
 * Write a baseline GeoPackage with `parcels` habitat parcels to `filePath`.
 *
 * @returns {{ path: string, parcels: number, bytes: number }}
 */
export function makeGeoPackage(filePath, parcels) {
  rmSync(filePath, { force: true })
  const db = new DatabaseSync(filePath)
  try {
    db.exec(`PRAGMA application_id = ${GPKG_APPLICATION_ID}`)
    createSystemTables(db)
    const bounds = boundsFor(parcels)
    createRedLineBoundary(db, bounds)
    createHabitats(db, parcels, bounds)
  } finally {
    db.close()
  }
  return { path: filePath, parcels, bytes: statSync(filePath).size }
}

// CLI: node scripts/make-gpkg.mjs <parcels> <outFile>
if (process.argv[1]?.endsWith('make-gpkg.mjs')) {
  const parcels = Number(process.argv[2] ?? 100)
  const out = process.argv[3] ?? `baseline-${parcels}.gpkg`
  const result = makeGeoPackage(out, parcels)
  console.log(
    `${result.path}: ${result.parcels} parcels, ${(result.bytes / 1024).toFixed(0)} KB`
  )
}
