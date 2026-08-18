// Seed (or re-seed) the big-baseline project that project-list-payload.jmx
// asserts against, straight into the local compose Postgres. Idempotent: one
// fixed project id, upserted, so re-runs re-point the row at the requested
// owner rather than piling up copies.
//
// Self-contained on purpose — the harness perf runner executes any
// scenarios/<name>.seed.mjs it finds beside the scenario before running it,
// so this script must not depend on harness helpers. Runnable standalone too:
//
//   node scenarios/project-list-payload.seed.mjs [--sub=<token-subject>] [--parcels=5000]
//
// --sub is the project owner — it MUST equal the `sub` the backend authenticates
// the request as, because the list endpoints only return projects owned by that
// sub. It defaults to the sub the cdp-defra-id-stub issues for the perf user that
// scripts/get-stub-token.mjs registers (bng-perf@bng.example.com), so a standalone
// local seed lines up with a stub-minted token. The harness/CDP runner overrides
// --sub with the freshly-minted token's sub; override it yourself only when
// driving the suite with a different token.
import { spawnSync } from "node:child_process";

// Deterministic sub the stub issues for bng-perf@bng.example.com — keep in step
// with PERF_USER_EMAIL / deterministicUuid in scripts/get-stub-token.mjs.
const PERF_USER_SUB = "e7ae699f-cfd0-5f66-b770-10248ab5c3c1";

const PROJECT_ID = "00000000-0000-4000-8000-000000000933";
const DEFAULT_PARCELS = Number(process.env.PERF_PARCELS ?? "2000");
const POSTGRES_IMAGE = process.env.PERF_POSTGRES_IMAGE ?? "postgis/postgis:16-3.5";

// The sub is interpolated into the SQL below; restrict it to token-subject-safe
// characters so a mangled CLI arg cannot break out of the string literal.
const SAFE_SUB = /^[A-Za-z0-9-]+$/;

const fail = (message) => {
  console.error(`✖ ${message}`);
  process.exit(1);
};

function capture(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

// Find the running Postgres container by image so we don't depend on the
// compose project name.
function findPostgresContainer() {
  const byImage = capture("docker", [
    "ps",
    "--filter",
    `ancestor=${POSTGRES_IMAGE}`,
    "--format",
    "{{.ID}}",
  ]);
  const id = byImage.trim().split("\n")[0];
  if (id) {
    return id;
  }
  const byName = capture("docker", ["ps", "--filter", "name=postgres", "--format", "{{.ID}}"]);
  return byName.trim().split("\n")[0] || null;
}

function seedSql(parcels, sub) {
  return `INSERT INTO bng.projects (id, user_id, relationship_id, org_id, project)
VALUES ('${PROJECT_ID}', '${sub}', NULL, NULL,
  jsonb_build_object(
    'name', 'Perf big baseline',
    'baseline', jsonb_build_object('habitats', (
      SELECT jsonb_agg(jsonb_build_object(
        'featureId', gen_random_uuid(),
        'parcelRef', 'p' || g,
        'habitat', 'Mixed scrub',
        'areaHectares', 0.5,
        'condition', 'Moderate'
      )) FROM generate_series(1, ${parcels}) g))))
ON CONFLICT (id) DO UPDATE
  SET user_id = EXCLUDED.user_id, project = EXCLUDED.project, updated_at = now();`;
}

function argValue(argv, name) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const argv = process.argv.slice(2);
const sub = argValue(argv, "sub") ?? PERF_USER_SUB;
const parcelsArg = argValue(argv, "parcels");
const parcels = parcelsArg === null ? DEFAULT_PARCELS : Number(parcelsArg);

if (!SAFE_SUB.test(sub)) {
  fail(`Refusing to seed for sub "${sub}" — expected only letters, digits and hyphens.`);
}
if (!Number.isInteger(parcels) || parcels <= 0) {
  fail(`--parcels must be a positive integer, got "${parcelsArg}".`);
}

const container = findPostgresContainer();
if (!container) {
  fail(`No running Postgres container found (image ${POSTGRES_IMAGE}). Is the local stack up?`);
}

console.error(`▸ seeding a ${parcels}-parcel baseline project for ${sub} (idempotent upsert)…`);
const psql = spawnSync(
  "docker",
  [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "dev",
    "-d",
    "bng_metric_backend",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    seedSql(parcels, sub),
  ],
  { stdio: "inherit" },
);
if (psql.status !== 0) {
  fail("Seeding failed — see psql output above.");
}
