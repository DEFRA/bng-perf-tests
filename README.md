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

Each `.jmx` under `scenarios/` is one suite. By default `entrypoint.sh` runs **every**
scenario in `scenarios/` in one task, resolving each suite's target and auth from the
scenario itself. Set `TEST_SCENARIO` to restrict the run to one suite (or a
space-separated list), e.g. `TEST_SCENARIO=project-list-payload`.

| Scenario                | Targets               | Covers                                                                 |
| ----------------------- | --------------------- | ---------------------------------------------------------------------- |
| `home-page`             | `bng-metric-frontend` | Minimal smoke check against the public home page (`/`).                |
| `project-list-payload`  | `bng-metric-backend`  | BMD-933 — the project list endpoints ship the whole project document.  |

Per scenario, the entrypoint picks the target and auth automatically: a scenario that
reads the `bearerToken` property drives the **backend** API and gets a minted stub token;
any other scenario targets the public **frontend** unauthenticated. The stub token is
minted at most once per task and shared across the authenticated scenarios. Each
scenario's JMeter report is published under its own `<results>/<scenario>/` prefix in S3
so a multi-scenario run keeps every dashboard. A scenario's assertion failures do not
fail the task (project-list-payload is red by design until the BMD-933 backend fix
lands); only an infrastructure failure — a missing scenario, a failed token mint, or a
scenario that produced no report — makes the task exit non-zero.

### `project-list-payload` (BMD-933)

Drives the two list endpoints — `GET /users/{userId}/projects` and `GET /projects` —
under concurrency and asserts the BMD-933 acceptance criteria. Both handlers currently
`.select()` every column and spread the full JSONB document into each row, so a list
that renders only `id`, `name`, `createdAt`, `updatedAt` ships each project's entire
baseline/postIntervention body (~3 KB per parcel — MBs at scale). The scenario encodes
the fix's acceptance criteria as assertions, so it **fails against an unfixed backend
and passes once the projection + `limit`/`offset` pagination land**:

- **Size Assertion** — each list response stays under `listSizeLimitBytes` regardless
  of baseline size ("response size is flat regardless of baseline size").
- **Response Assertion** — the payload excludes the document-body-only keys `habitats`
  and `postIntervention` ("list responses exclude the document body").
- **Response Assertion** — the payload includes the projected `has_baseline` flag.
- **200 on a paginated request** to each endpoint ("both list endpoints accept
  `limit`/`offset`"). Pre-fix, `GET /users/{userId}/projects` Joi-rejects unknown query
  params with a 400, so this assertion fails until pagination is added.
- **Duration Assertion** — guards against the multi-second event-loop stall a multi-MB
  synchronous `JSON.stringify` causes under load.

The entrypoint targets `bng-metric-backend.<env>.cdp-int.defra.cloud` for this scenario
automatically, so no `SERVICE_ENDPOINT` is needed on CDP. Override `SERVICE_ENDPOINT`
(and `SERVICE_PORT` / `SERVICE_URL_SCHEME`) only for a one-off target such as a local
backend.

### Authenticating: a real cdp-defra-id-stub token

The endpoints require a Defra ID Bearer token. Rather than replicate the interactive
OIDC login in JMeter — or add an auth-bypass to the backend — this suite **mints a real
token from the `cdp-defra-id-stub`** headlessly, the same login the app performs. This
is the DEFRA perf-test pattern (see `DEFRA/trade-demo-perf-tests`): `entrypoint.sh` runs
`scripts/get-stub-token.mjs` (register → authorize → token, PKCE) before JMeter and
forwards the token into the `bearerToken` property with xtrace off, so it never lands in
the committed `.jmx` or the CDP logs.

**The backend must trust stub tokens on the target environment** — i.e. its
`OIDC_DISCOVERY_URL`/`OIDC_ISSUER` must point at that environment's
`cdp-defra-id-stub` (already the case on **local** and **dev**; for **perf-test** this is
a one-line change in `cdp-app-config` `services/bng-metric-backend/perf-test`). No
backend code, and no `PERF_TEST_AUTH_TOKEN`.

The stub base URL defaults to `https://cdp-defra-id-stub.<ENVIRONMENT>.cdp-int.defra.cloud/cdp-defra-id-stub`;
override any of the minting inputs if needed:

| Env var                 | Default                                                        | Purpose                                             |
| ----------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `BEARER_TOKEN`          | _(minted)_                                                     | Preset a token to **skip** minting (e.g. a pre-minted token on the CDP task). |
| `STUB_BASE_URL`         | `…/cdp-defra-id-stub.<ENVIRONMENT>.cdp-int.defra.cloud/…`      | The stub to mint against.                           |
| `OIDC_REDIRECT_URI`     | frontend callback for the env (local: `http://localhost:3000/auth/callback`) | Echoed back by the stub with the auth code; read off the 302 without being called. Must not contain `localhost` on CDP — the WAF 403s an `/authorize` request whose query carries a localhost target. |
| `OIDC_CLIENT_ID`        | `63983fc2-cfff-45bb-8ec2-959e21062b9a`                        | Stub OIDC client (the shared CDP stub client).      |
| `USER_ID`               | minted token `sub`                                             | `/users/{userId}` path segment (token `sub` is trusted, not this). |
| `LIST_SIZE_LIMIT_BYTES` | `262144`                                                       | Max allowed list response size (256 KB).            |
| `LIST_MAX_LATENCY_MS`   | `2000`                                                         | Max allowed list response time.                     |
| `LIST_LIMIT` / `LIST_OFFSET` | `50` / `0`                                                | Pagination params exercised against both endpoints. |
| `LIST_THREADS` / `LIST_RAMP_SECONDS` / `LIST_LOOPS` | `10` / `10` / `20`                | Load profile.                                       |

### Seed the data — owner must match the minted `sub`

The environment must hold at least one project **owned by the `sub` the stub issues**,
with a baseline uploaded — ideally a large, multi-thousand-parcel one — or the
`has_baseline` and document-body assertions have nothing to exercise (and `has_baseline`
fails against the empty list). The list endpoints only return projects owned by that
`sub`.

`scenarios/project-list-payload.seed.mjs` upserts that project into the local compose
Postgres. Its `--sub` defaults to the stub perf-user's deterministic sub
(`e7ae699f-cfd0-5f66-b770-10248ab5c3c1`, for `bng-perf@bng.example.com`), so a local seed
lines up with the minted token without an argument:

```sh
node scenarios/project-list-payload.seed.mjs            # owner: the stub perf user
node scenarios/project-list-payload.seed.mjs --sub=<other-sub>
```

The seed script talks to local Docker only (it `docker exec`s into the compose
Postgres), so it cannot reach a CDP-managed RDS. For any deployed environment the suite
seeds through the **backend API instead** — see below.

#### Seeding on CDP — `scripts/seed-via-api.mjs`

`entrypoint.sh` seeds the owner's projects by driving the backend's own
`POST /projects/new` with the minted stub token, before the first authenticated scenario
runs. It needs no database access, no GeoPackage upload and no Portal migration — only a
reachable backend that trusts the stub — so the same step works on **local**, **dev** and
**perf-test**. It runs at most once per task and is idempotent to a **target count**: it
first lists what the owner already has and creates only the shortfall, so re-running a
task never piles rows up. Set `SEED_VIA_API=false` to skip it (e.g. when the environment
is already seeded another way).

Two properties of the API path shape it:

- **Payload cap.** Hapi's default request-body limit is 1 MB and the create route sets no
  override, so each project body is sized to a byte budget below that cap. To build a
  larger corpus the step seeds **several** projects rather than one oversized baseline —
  which suits the list scenario, since a longer list is what balloons the payload.
- **No delete.** `POST /projects/new` always inserts a fresh row and the API exposes no
  project delete, so idempotency is at the target-count level, not a fixed id. If you need
  a single multi-MB baseline row (bigger than the 1 MB create cap allows), seed it through
  the DB/Liquibase path instead; the API step cannot.

| Env var              | Default    | Purpose                                                              |
| -------------------- | ---------- | ------------------------------------------------------------------- |
| `SEED_VIA_API`       | `true`     | Set `false` to skip API seeding entirely.                           |
| `SEED_PROJECT_COUNT` | `5`        | Target number of baseline projects the owner should end up with.    |
| `SEED_BYTE_BUDGET`   | `800000`   | Byte budget per project body; kept under Hapi's 1 MB cap.           |

The `scenarios/project-list-payload.seed.mjs` Docker-Postgres seed remains the faster
local option (a single fixed-id, large baseline); `seed-via-api.mjs` is the portable
equivalent for anywhere the DB is out of reach.

> **Local shortcut:** from the harness, `npm run perf` does all of this for you — mints
> the stub token, seeds the project under its sub, runs JMeter, and prints a per-endpoint
> pass/fail summary. The steps below are for running the container directly / on CDP.

Run it locally against a backend on `localhost:3001` with:

```sh
docker build . -t bng-perf-tests
docker run --rm --network host \
  -e TEST_SCENARIO=project-list-payload \
  -e ENVIRONMENT=local \
  -e SERVICE_ENDPOINT=localhost -e SERVICE_PORT=3001 -e SERVICE_URL_SCHEME=http \
  -e STUB_BASE_URL=http://localhost:3200/cdp-defra-id-stub \
  -e RESULTS_OUTPUT_S3_PATH='s3://my-bucket' -e S3_ENDPOINT='http://host.docker.internal:4566' \
  -e AWS_ACCESS_KEY_ID='test' -e AWS_SECRET_ACCESS_KEY='test' -e AWS_REGION='eu-west-2' \
  bng-perf-tests
```

(The backend must be running with its OIDC pointed at that same stub — the default on a
local `tilt up`. `USER_ID` is left to the minted `sub`; the backend trusts the token
`sub`, not the path segment. Seed the project first so the assertions have data.)

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
