// Seed baseline-bearing projects for the perf user by driving the BACKEND API
// itself — one authenticated `POST /projects/new` per project — rather than
// writing to the database directly. This is the portable counterpart to
// scenarios/project-list-payload.seed.mjs: that script `docker exec`s into a
// LOCAL compose Postgres and cannot reach a CDP-managed RDS, whereas this one
// needs nothing but the backend URL and the same stub Bearer token the suite
// already mints, so it works against any environment where the backend trusts
// the stub (local, dev, perf-test).
//
// Why this works: `POST /projects/new` accepts an arbitrary `project` JSONB body
// and stamps it with the token `sub` and the caller's current org context —
// exactly the scope the list endpoints read back through. The org-less stub perf
// user resolves to a null relationship, and the seeded rows carry no
// relationship either, so they land in the owner-fallback branch of the
// visibility predicate and are returned to the same token. No DB access, no
// GeoPackage upload, no cdp-uploader.
//
// Two properties of the API path shape the design:
//   - Hapi's default payload cap is 1 MB and the create route sets no override,
//     so a single project body must stay under it. We size each baseline to a
//     byte BUDGET below that cap and, when a bigger corpus is wanted, seed
//     SEVERAL projects rather than one oversized one — which also suits the
//     list scenario (a longer list is what balloons the payload).
//   - `POST /projects/new` always inserts a fresh row (no upsert, and the API
//     exposes no delete), so this script is idempotent at the level of a TARGET
//     COUNT, not a fixed id: it first lists what the owner already has and only
//     creates the shortfall, so re-running a task does not pile rows up
//     unbounded.
//
// Usage:  API_BASE_URL=https://bng-metric-backend.dev.cdp-int.defra.cloud \
//         BEARER_TOKEN=<jwt> node scripts/seed-via-api.mjs
import { randomUUID } from "node:crypto";

const note = (msg) => process.stderr.write(`${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`✖ seed-via-api: ${msg}\n`);
  process.exit(1);
};

// ── inputs ──────────────────────────────────────────────────────────────────
const API_BASE_URL = process.env.API_BASE_URL;
const BEARER_TOKEN = process.env.BEARER_TOKEN;

// How many baseline-bearing projects the owner should end up with. The script
// tops up to this figure; it never deletes.
const DEFAULT_TARGET_COUNT = 5;
// Byte budget for one project body. Kept comfortably under Hapi's 1 MB default
// payload cap so a create can never 413.
const DEFAULT_BYTE_BUDGET = 800_000;
// Absolute guard so a mis-set budget can never build a runaway array.
const MAX_PARCELS_PER_PROJECT = 20_000;
const MIN_PARCELS_PER_PROJECT = 1;

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const ERROR_SNIPPET_MAX = 300;

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

const TARGET_COUNT = positiveIntEnv("SEED_PROJECT_COUNT", DEFAULT_TARGET_COUNT);
const BYTE_BUDGET = positiveIntEnv("SEED_BYTE_BUDGET", DEFAULT_BYTE_BUDGET);

// ── project body ──────────────────────────────────────────────────────────────
// One area-habitat parcel in the canonical baseline shape (see the backend's
// src/validation/project.js habitatSchema): featureId + status are the only
// required fields; the rest add representative bulk. Unknown keys would fail
// validation, so every key here is one the schema recognises.
function makeParcel(index) {
  return {
    featureId: randomUUID(),
    ref: `perf-${index}`,
    type: "Mixed scrub",
    broadType: "Heathland and shrub",
    distinctiveness: "Medium",
    condition: "Moderate",
    area: 5000,
    status: "Complete",
  };
}

// Size the parcel array to the byte budget by measuring one serialised parcel
// against the fixed envelope, so the body approaches — but never exceeds — the
// budget regardless of the parcel shape.
function parcelCountForBudget(name) {
  const envelopeBytes = Buffer.byteLength(
    JSON.stringify({ project: { name, baseline: { habitats: [] } } }),
  );
  const perParcelBytes = Buffer.byteLength(`${JSON.stringify(makeParcel(0))},`);
  const room = BYTE_BUDGET - envelopeBytes;
  const fit = Math.floor(room / perParcelBytes);
  return Math.max(
    MIN_PARCELS_PER_PROJECT,
    Math.min(MAX_PARCELS_PER_PROJECT, fit),
  );
}

function makeProjectBody(name, parcels) {
  const habitats = [];
  for (let i = 0; i < parcels; i += 1) {
    habitats.push(makeParcel(i));
  }
  return { project: { name, baseline: { habitats } } };
}

// ── API calls ─────────────────────────────────────────────────────────────────
const authHeader = () => ({ authorization: `Bearer ${BEARER_TOKEN}` });

function isBaselineBearing(project) {
  if (project?.has_baseline === true) {
    return true;
  }
  // Pre-fix the list still ships the whole document, so fall back to counting
  // the embedded baseline habitats when the projected flag is absent.
  const habitats =
    project?.baseline?.habitats ?? project?.project?.baseline?.habitats ?? [];
  return Array.isArray(habitats) && habitats.length > 0;
}

async function countExistingBaselineProjects() {
  const res = await fetch(`${API_BASE_URL}/projects`, { headers: authHeader() });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    fail(
      `GET /projects returned HTTP ${res.status}: ${detail.slice(0, ERROR_SNIPPET_MAX)} — is ${API_BASE_URL} reachable and does it trust the stub token?`,
    );
  }
  const body = await res.json();
  const projects = Array.isArray(body) ? body : (body?.projects ?? []);
  return projects.filter(isBaselineBearing).length;
}

async function createProject(name, parcels) {
  const res = await fetch(`${API_BASE_URL}/projects/new`, {
    method: "POST",
    headers: { ...authHeader(), "content-type": "application/json" },
    body: JSON.stringify(makeProjectBody(name, parcels)),
  });
  if (res.status < HTTP_OK_MIN || res.status > HTTP_OK_MAX) {
    const detail = await res.text().catch(() => "");
    fail(
      `POST /projects/new returned HTTP ${res.status}: ${detail.slice(0, ERROR_SNIPPET_MAX)}`,
    );
  }
}

async function main() {
  if (!API_BASE_URL) {
    fail("API_BASE_URL is required (e.g. https://bng-metric-backend.dev.cdp-int.defra.cloud).");
  }
  if (!BEARER_TOKEN) {
    fail("BEARER_TOKEN is required — mint one with scripts/get-stub-token.mjs.");
  }

  const existing = await countExistingBaselineProjects();
  const shortfall = Math.max(0, TARGET_COUNT - existing);
  note(
    `▸ seed-via-api: owner has ${existing} baseline project(s); target ${TARGET_COUNT} → creating ${shortfall}`,
  );
  if (shortfall === 0) {
    note("▸ seed-via-api: nothing to do");
    return;
  }

  for (let i = 0; i < shortfall; i += 1) {
    const name = `Perf big baseline ${existing + i + 1}`;
    const parcels = parcelCountForBudget(name);
    note(`▸ seed-via-api: creating "${name}" with ${parcels} parcels`);
    // Sequential on purpose: seeding is a one-off setup step, and a serial
    // loop keeps the create path off the load profile the scenario measures.
    await createProject(name, parcels);
  }
  note(`▸ seed-via-api: created ${shortfall} project(s)`);
}

await main();
