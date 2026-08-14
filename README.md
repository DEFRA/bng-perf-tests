# bng-perf-tests

A JMeter based test runner for the CDP Platform.

- [Licence](#licence)
  - [About the licence](#about-the-licence)

## Build

Test suites are built automatically by the [.github/workflows/publish.yml](.github/workflows/publish.yml) action whenever a change are committed to the `main` branch.
A successful build results in a Docker container that is capable of running your tests on the CDP Platform and publishing the results to the CDP Portal.

## Run

The performance test suites are designed to be run from the CDP Portal.
The CDP Platform runs test suites in much the same way it runs any other service, it takes a docker image and runs it as an ECS task, automatically provisioning infrastructure as required.

## Scenarios

Each `scenarios/<name>.jmx` is a self-contained test plan. Pick one with
`TEST_SCENARIO=<name>` (CDP env var, or `PERF_SCENARIO=<name>` under the harness
runner). Every target/tuning knob is an overridable JMeter property — the
`.jmx`'s own comment block is the authoritative list.

| Scenario                   | Targets  | Auth | What it proves |
| -------------------------- | -------- | ---- | -------------- |
| `home-page`                | frontend | no   | the public home page loads within budget (smoke test) |
| `baseline-overlap-scaling` | backend + cdp-uploader | yes | BMD-911: baseline validation stops scaling quadratically with parcel count |

### `baseline-overlap-scaling` (BMD-911)

The baseline validation query runs one **un-indexed `O(N²)` self-join** over the
habitat parcels (`c_overlap_offending` in
`backend/src/validation/geopackage/postgis/index.js`). At a few thousand parcels
that join dominates, so `POST /baseline/validate/{uploadId}` grows with the
**square** of the parcel count. A unit/integration test can't see this — the
endpoint returns the identical result before and after the fix; only the
wall-clock changes, and only at scale.

The scenario is **self-contained**: JMeter drives the whole CDP upload pipeline
itself and times each step as its own labelled sampler —

```
initiate  →  upload-and-scan  →  status (poll until ready)  →  validate
   ↑ setup       ↑ upload throughput          ↑ scan+S3 settle   ↑ BMD-911 signal
```

so the multi-second upload/virus-scan time never drowns the validation cost. It
stages **two committed baseline GeoPackages** (`N` and `2N` non-overlapping
parcels) and runs the pipeline for each.

**Reading the result:** compare the two `validate @<size>` latencies in the
summary. A quadratic curve roughly **quadruples** from `N` to `2N` (~4×); a
linear (post-fix) curve roughly **doubles** (~2×). For the cleanest single-shot
ratio, run one request at a time (`PERF_THREADS=1 PERF_LOOPS=1`). The
`validateMaxMsLarge` DurationAssertion encodes the post-fix expectation, so the
suite **fails by design** until the GiST index lands.

**Fixtures (git-LFS).** The two `.gpkg` live in
[`scenarios/fixtures/`](scenarios/fixtures/README.md) and are tracked with
git-LFS. After cloning, materialise them with:

```bash
git lfs pull
```

The CI build (`publish.yml`) checks out with `lfs: true` so the real files are
baked into the Docker image; see the fixtures README for how to (re)generate
them with the harness `gen-gpkg` tool.

**Running it from the CDP Portal.** Set `TEST_SCENARIO=baseline-overlap-scaling`,
point `SERVICE_ENDPOINT` at the **backend**, and supply a `BEARER_TOKEN` the
backend accepts. `entrypoint.sh` derives the cdp-uploader host from
`ENVIRONMENT` (override with `UPLOADER_ENDPOINT`) and points `fixtureDir` at the
baked-in fixtures. Load and budgets are tunable via `PERF_THREADS` / `PERF_LOOPS`
/ `VALIDATE_MAX_MS_LARGE` etc. (see `entrypoint.sh`).

**Running it under the harness** (`bng-metric-harness`, against the local compose
stack): `npm run perf` mints a stub token, targets the backend, and reads the
fixtures from the mounted `scenarios/fixtures`. Use
`PERF_SCENARIO=baseline-overlap-scaling` to run just this one, and
`PERF_THREADS=1 PERF_LOOPS=1` for the clean scaling number.

## Running the suite locally

You can run the suite locally with Docker Compose. Compose builds the JMeter image
and fires the scenario at an **already-running frontend on your host**, then
publishes the results to a LocalStack S3 bucket (and to `./reports` on your host).

### 1. Start the app under test

The compose stack does **not** stand the frontend up — the frontend needs the
whole backend stack (Postgres, Redis, Defra ID stub, OIDC discovery), which lives
in `bng-metric-backend`'s own compose. Bring the app up first so it is serving on
port 3000. The home-page smoke test only needs the frontend reachable — `/` is a
public page.

### 2. Run the suite

```bash
# in bng-perf-tests
docker compose up --build
```

This brings up:

* `development`: the container that runs the perf scenario (defaults to `home-page`)
* `localstack`: stands in for AWS S3 so the results-publish step succeeds

By default it targets `http://host.docker.internal:3000` (your host's frontend).
Once LocalStack is healthy the run starts automatically, and the container exits
when the run finishes.

### 3. Point it somewhere else (optional)

Every target knob is an overridable env var. To hit a deployed CDP environment
instead of your local frontend:

```bash
SERVICE_ENDPOINT=bng-metric-frontend.dev.cdp-int.defra.cloud \
SERVICE_PORT=443 SERVICE_URL_SCHEME=https ENVIRONMENT=dev \
docker compose up --build
```

To run a different scenario file (`scenarios/<name>.jmx`):

```bash
TEST_SCENARIO=home-page docker compose up --build
```

### Notes

* The `test-results` S3 bucket is created automatically inside LocalStack.
* Logs and reports are written to `./reports` on your host.
* If you change `entrypoint.sh` or a scenario, rerun with `docker compose up --build`
  so the image is rebuilt.
* On Docker Desktop `host.docker.internal` resolves to the host natively; on Linux
  the compose file adds the `host-gateway` mapping so it resolves there too.

## Local Testing with LocalStack

### Build a new Docker image
```
docker build . -t my-performance-tests
```
### Create a Localstack bucket
```
aws --endpoint-url=localhost:4566 s3 mb s3://my-bucket
```

### Run performance tests

```
docker run \
-e S3_ENDPOINT='http://host.docker.internal:4566' \
-e RESULTS_OUTPUT_S3_PATH='s3://my-bucket' \
-e AWS_ACCESS_KEY_ID='test' \
-e AWS_SECRET_ACCESS_KEY='test' \
-e AWS_SECRET_KEY='test' \
-e AWS_REGION='eu-west-2' \
my-performance-tests
```

docker run -e S3_ENDPOINT='http://host.docker.internal:4566' -e RESULTS_OUTPUT_S3_PATH='s3://cdp-infra-dev-test-results/cdp-portal-perf-tests/95a01432-8f47-40d2-8233-76514da2236a' -e AWS_ACCESS_KEY_ID='test' -e AWS_SECRET_ACCESS_KEY='test' -e AWS_SECRET_KEY='test' -e AWS_REGION='eu-west-2' -e ENVIRONMENT='perf-test' my-performance-tests


## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government licence v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
