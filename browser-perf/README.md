# browser-perf — BMD-911 baseline overlap-scaling (CDP)

A browser-driven (Playwright) performance test that proves BMD-911: baseline
validation must stop scaling **quadratically** with habitat-parcel count.

## Why this isn't JMeter

The signal is the cost of `POST /baseline/validate/{uploadId}`, which is behind
Defra ID. Against the **real deployed** stack (which is where policy says perf
tests run) there is no stub and no headless token grant — the only way in is the
**real Government Gateway login**, an interactive browser flow. JMeter can't do
that, and a browser login never exposes a raw bearer token (the frontend keeps it
server-side). So — exactly like the journey-tests in `RUN_MODE=e2e` — this test
**authenticates a real session and drives the frontend UI**, letting the frontend
call `/baseline/validate` itself. It reproduces the journey-tests' login and
upload flows here (that repo is not imported).

## What it measures

Log in → create a project → upload the **N-parcel** baseline, then the **2N**
one. Clicking *Continue* posts the file to cdp-uploader, which redirects to
`/projects/{id}/upload-received`; that handler runs the validation server-side, so
the received request's **time-to-first-byte is the validation cost** (plus a
roughly size-independent scan-settle offset that the ratio divides out). The test
asserts the **2N/N ratio stays sub-quadratic** (`SCALING_RATIO_MAX`, default 3.0):
a quadratic curve ~quadruples, a linear (post-fix) curve ~doubles. It **fails by
design** against an unfixed backend and passes once the GiST index lands. The
fixtures are the same two committed git-LFS `.gpkg` the JMeter scenario uses,
under `../scenarios/fixtures`.

## Running on CDP (the sanctioned path)

Build from the **repo root** (so the fixtures are copied in) with LFS materialised:

```sh
git lfs pull
docker build -f browser-perf/Dockerfile -t bng-perf-browser .
```

Configure the CDP run:

| Env var | Value |
| --- | --- |
| `ENVIRONMENT` | target env, e.g. `dev` (frontend URL is derived from it) |
| `DEFRA_ID_USERNAME` / `DEFRA_ID_PASSWORD` | the **same** no-MFA test-account secrets the journey-tests use in e2e (BNG completer role) |
| `HTTPS_PROXY` / `HTTP_PROXY` | the platform egress proxy (needed for the external Defra ID login) |
| `RESULTS_OUTPUT_S3_PATH` / `S3_ENDPOINT` | results bucket (set by the Portal) |
| `SCALING_RATIO_MAX` | scaling gate, default `3.0` |
| `VALIDATE_MAX_MS_LARGE` | optional absolute budget on the large validate (ms); `0` disables |
| `BASE_URL` | override the derived frontend URL if needed |

`entrypoint.sh` runs the test and publishes `reports/` to the results bucket, then
exits with the test's status (so the fail-by-design gate marks the run).

## Two login modes

Same test, two sign-in flows — auto-selected from the target, or forced with
`PERF_LOGIN_MODE`:

- **`real`** (default for a deployed target) — the Government Gateway login with
  `DEFRA_ID_USERNAME`/`DEFRA_ID_PASSWORD`. This is what **perf-test** and the other
  real-B2C CDP envs use.
- **`stub`** (default for a localhost target) — the `cdp-defra-id-stub` registration
  flow (reproduced from the journey-tests' local path). No credentials needed.

The env target picks the environment; the two never mix (the stub's pages are not
the real Defra ID ones).

## Running locally

Against the local stack (backend compose up + frontend on :3000), from the harness
root the one-liner is:

```sh
npm run perf:browser -- --local
```

or directly:

```sh
cd browser-perf
npm install && npx playwright install --with-deps chromium
BASE_URL=http://localhost:3000 npm run perf   # stub login auto-selected
```

## Running against perf-test (or another deployed env)

```sh
# from the harness root
npm run perf:browser -- --cdp-env=perf-test
```

`perf-test` uses **real Defra ID**, so set the `DEFRA_ID_USERNAME`/`DEFRA_ID_PASSWORD`
secrets (BNG completer, no MFA) and, off-platform, an egress `HTTPS_PROXY`.

## Caveats (please verify on first run)

- **Selectors are unverified here.** They reproduce the journey-tests' verified
  page objects, but the hosted Defra ID pages can change — confirm with a headed
  run against dev (`npm run perf:headed`) if login fails.
- **Timing includes a scan-settle offset.** The received request's TTFB is
  `waitForUploadReady` (virus scan) + validate. It's ~constant across sizes, so the
  ratio still exposes the quadratic, but the absolute numbers aren't pure validate.
- **CDP registration.** This image is a Playwright/browser image (like the
  journey-tests), not the JMeter `cdp-perf-test-docker` base — confirm your CDP
  perf-test build points at `browser-perf/Dockerfile` (repo-root context).
