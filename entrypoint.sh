#!/bin/sh
set -x

echo "run_id: $RUN_ID in $ENVIRONMENT"

NOW=$(date +"%Y%m%d-%H%M%S")

if [ -z "${JM_HOME}" ]; then
  JM_HOME=/opt/perftest
fi

JM_SCENARIOS=${JM_HOME}/scenarios
JM_REPORTS=${JM_HOME}/reports
JM_LOGS=${JM_HOME}/logs

mkdir -p ${JM_REPORTS} ${JM_LOGS}

SERVICE_PORT=${SERVICE_PORT:-443}
SERVICE_URL_SCHEME=${SERVICE_URL_SCHEME:-https}
STUB_BASE_URL=${STUB_BASE_URL:-https://cdp-defra-id-stub.${ENVIRONMENT}.cdp-int.defra.cloud/cdp-defra-id-stub}

# Redirect URI presented during the stub OIDC dance. The stub echoes the auth
# code back to whatever redirect_uri is given (it does not validate it against a
# registered client), and get-stub-token.mjs reads the code straight off the 302
# Location without ever calling the URL — so this only has to be a string, not a
# reachable endpoint. It MUST NOT contain `localhost`, though: on CDP the WAF
# 403s an /authorize request whose query carries a localhost/SSRF-looking target
# (that is what failed the perf-test run). Use the deployed frontend's callback
# on CDP; local (no WAF) keeps the real localhost callback.
if [ "${ENVIRONMENT}" = "local" ]; then
  OIDC_REDIRECT_URI=${OIDC_REDIRECT_URI:-http://localhost:3000/auth/callback}
else
  OIDC_REDIRECT_URI=${OIDC_REDIRECT_URI:-https://bng-metric-frontend.${ENVIRONMENT}.cdp-int.defra.cloud/auth/callback}
fi

# The suite is a SINGLE JMeter plan with two thread groups — the public home page
# (frontend) and the authenticated project-list endpoints (backend) — so one run
# produces one report. TEST_SCENARIO overrides the plan name; an unknown name
# falls back to the default, so a stale placeholder (e.g. the base image's
# inherited TEST_SCENARIO=test) can never fail the run.
SCENARIO=${TEST_SCENARIO:-bng-perf}
if [ ! -f "${JM_SCENARIOS}/${SCENARIO}.jmx" ]; then
  echo "WARNING: scenario '${SCENARIO}.jmx' not found in ${JM_SCENARIOS} — falling back to bng-perf" >&2
  SCENARIO=bng-perf
fi
SCENARIOFILE=${JM_SCENARIOS}/${SCENARIO}.jmx

# Per-service targets. The home-page group hits the frontend; the project-list
# group hits the backend. SERVICE_ENDPOINT still overrides the BACKEND host (kept
# for back-compat with existing CDP task config); FRONTEND_DOMAIN / BACKEND_DOMAIN
# override each host directly. All default to the deterministic CDP hostnames.
FRONTEND_DOMAIN=${FRONTEND_DOMAIN:-bng-metric-frontend.${ENVIRONMENT}.cdp-int.defra.cloud}
BACKEND_DOMAIN=${SERVICE_ENDPOINT:-${BACKEND_DOMAIN:-bng-metric-backend.${ENVIRONMENT}.cdp-int.defra.cloud}}
# Ports default to the shared SERVICE_PORT; override per service when the two
# hosts differ (e.g. a local stack: frontend :3000, backend :3001).
FRONTEND_PORT=${FRONTEND_PORT:-${SERVICE_PORT}}
BACKEND_PORT=${BACKEND_PORT:-${SERVICE_PORT}}

# Seed baseline projects through the backend API before the run, so the list
# endpoints have data to exercise on any environment — no DB access needed. Set
# SEED_VIA_API=false to skip (e.g. when the target is already seeded).
SEED_VIA_API=${SEED_VIA_API:-true}

# One-shot run-config banner. xtrace off so it reads as a clean block and so no
# secret can ever be echoed here. Surfaces the resolved config up front — the
# resolved scenario, the two targets, and OIDC_REDIRECT_URI (confirms the
# non-localhost WAF fix is active) — so a run can be triaged from the first
# screen of logs.
set +x
echo "──────────────────────────── bng-perf-tests run config ────────────────────────────"
echo "  run_id:              ${RUN_ID:-<unset>}"
echo "  environment:         ${ENVIRONMENT:-<unset>}"
echo "  scenario:            ${SCENARIO}"
echo "  frontend target:     ${SERVICE_URL_SCHEME}://${FRONTEND_DOMAIN}:${FRONTEND_PORT}"
echo "  backend target:      ${SERVICE_URL_SCHEME}://${BACKEND_DOMAIN}:${BACKEND_PORT}"
echo "  stub base URL:       ${STUB_BASE_URL}"
echo "  oidc redirect_uri:   ${OIDC_REDIRECT_URI}"
echo "  seed via API:        ${SEED_VIA_API} (target ${SEED_PROJECT_COUNT:-5} project(s))"
echo "────────────────────────────────────────────────────────────────────────────────────"
set -x

# Mint the cdp-defra-id-stub token for the authenticated backend group. Sets
# BEARER_TOKEN (and USER_ID to the minted sub when unset). No-op if BEARER_TOKEN
# is already supplied.
mint_token() {
  if [ -n "${BEARER_TOKEN}" ]; then
    return 0
  fi
  # xtrace OFF so the token is never echoed into the CDP logs.
  set +x
  echo "▸ minting a cdp-defra-id-stub token from ${STUB_BASE_URL}"
  MINT_ERR=$(mktemp)
  BEARER_TOKEN=$(STUB_BASE_URL="${STUB_BASE_URL}" OIDC_REDIRECT_URI="${OIDC_REDIRECT_URI}" node "${JM_HOME}/scripts/get-stub-token.mjs" 2>"${MINT_ERR}")
  MINT_STATUS=$?
  cat "${MINT_ERR}" >&2
  if [ ${MINT_STATUS} -ne 0 ] || [ -z "${BEARER_TOKEN}" ]; then
    rm -f "${MINT_ERR}"
    set -x
    echo "ERROR: failed to mint a stub token. Is ${STUB_BASE_URL} reachable, and is the backend's OIDC_DISCOVERY_URL pointed at that stub?" >&2
    return 1
  fi
  # The backend trusts the token sub, not the path segment, but keep USER_ID
  # consistent with the minted sub when the caller has not set one.
  if [ -z "${USER_ID}" ]; then
    USER_ID=$(sed -n 's/^sub=//p' "${MINT_ERR}")
  fi
  rm -f "${MINT_ERR}"
  set -x
  return 0
}

# Seed baseline projects via the backend API, sharing the minted perf user.
# Idempotent to a target count (scripts/seed-via-api.mjs tops up to
# SEED_PROJECT_COUNT, never deletes), so re-runs do not pile rows up.
# $1 = backend base URL (scheme://host:port). No-op when SEED_VIA_API is not true.
seed_via_api() {
  api_base_url="$1"
  if [ "${SEED_VIA_API}" != "true" ]; then
    return 0
  fi
  # xtrace OFF so BEARER_TOKEN is never echoed into the CDP logs.
  set +x
  echo "▸ seeding baseline projects via ${api_base_url}/projects/new"
  API_BASE_URL="${api_base_url}" BEARER_TOKEN="${BEARER_TOKEN}" \
    node "${JM_HOME}/scripts/seed-via-api.mjs"
  SEED_STATUS=$?
  set -x
  if [ ${SEED_STATUS} -ne 0 ]; then
    echo "ERROR: seed-via-api failed against ${api_base_url}" >&2
    return 1
  fi
  return 0
}

add_prop() {
  # $1 = JMeter property name, $2 = value. Skips empty values so the .jmx default
  # wins rather than being overridden with an empty string.
  if [ -n "$2" ]; then
    SCENARIO_PROPS="${SCENARIO_PROPS} -J$1=$2"
  fi
}

if [ ! -f "${SCENARIOFILE}" ]; then
  echo "ERROR: scenario ${SCENARIO}.jmx not found in ${JM_SCENARIOS}" >&2
  exit 1
fi

echo "=== Scenario: ${SCENARIO} (frontend=${FRONTEND_DOMAIN}, backend=${BACKEND_DOMAIN}) ==="

# The plan drives the authenticated backend endpoints, so a token and seeded data
# are prerequisites — both gate the run. Running the list group against an empty
# owner, or with no token, would prove nothing.
if ! mint_token; then
  echo "ERROR: no stub token — cannot run ${SCENARIO}" >&2
  exit 1
fi
if ! seed_via_api "${SERVICE_URL_SCHEME}://${BACKEND_DOMAIN}:${BACKEND_PORT}"; then
  echo "ERROR: seeding failed — cannot run ${SCENARIO}" >&2
  exit 1
fi

# Assemble properties with xtrace OFF so `set -x` never echoes BEARER_TOKEN. JWTs
# and the numeric tunables contain no whitespace, so leaving ${SCENARIO_PROPS}
# unquoted to word-split into separate args is safe.
set +x
SCENARIO_PROPS=""
add_prop bearerToken "${BEARER_TOKEN}"
add_prop userId "${USER_ID}"
add_prop maxResponseMs "${MAX_RESPONSE_MS}"
add_prop homeThreads "${HOME_THREADS}"
add_prop homeRampSeconds "${HOME_RAMP_SECONDS}"
add_prop homeLoops "${HOME_LOOPS}"
add_prop listThreads "${LIST_THREADS}"
add_prop listRampSeconds "${LIST_RAMP_SECONDS}"
add_prop listLoops "${LIST_LOOPS}"
add_prop listSizeLimitBytes "${LIST_SIZE_LIMIT_BYTES}"
add_prop listMaxLatencyMs "${LIST_MAX_LATENCY_MS}"
add_prop limit "${LIST_LIMIT}"
add_prop offset "${LIST_OFFSET}"

REPORTFILE=${NOW}-perftest-${SCENARIO}-report.csv
LOGFILE=${JM_LOGS}/perftest-${SCENARIO}.log

# -f forces JMeter to overwrite an existing results file / report folder.
jmeter -n -t ${SCENARIOFILE} -e -l "${REPORTFILE}" -o ${JM_REPORTS} -j ${LOGFILE} -f \
  -Jenv="${ENVIRONMENT}" \
  -JfrontendDomain="${FRONTEND_DOMAIN}" \
  -JbackendDomain="${BACKEND_DOMAIN}" \
  -JfrontendPort="${FRONTEND_PORT}" \
  -JbackendPort="${BACKEND_PORT}" \
  -Jport="${SERVICE_PORT}" \
  -Jprotocol="${SERVICE_URL_SCHEME}" \
  ${SCENARIO_PROPS}
set -x

# Publish the single dashboard at the ROOT of the results prefix — the object the
# CDP portal serves as the report. Assertion failures do NOT gate: the list group
# encodes unshipped BMD-933 acceptance criteria and is red by design until the
# backend fix lands. This applies to the home-page group too — a down or slow
# frontend shows red samples in the report but still exits 0, so the portal
# dashboard, not the task exit code, is the source of truth. Only mint/seed and an
# infrastructure failure to publish (no report) gate the run.
if [ -z "${RESULTS_OUTPUT_S3_PATH}" ]; then
  echo "RESULTS_OUTPUT_S3_PATH is not set — skipping S3 publish"
  exit 0
fi
if [ ! -f "${JM_REPORTS}/index.html" ]; then
  echo "ERROR: ${JM_REPORTS}/index.html not found — nothing to publish" >&2
  exit 1
fi
# Both copies must succeed — publishing the report IS the point of the run, so a
# failed upload has to fail the task. Without this the portal shows "No report
# found" on a green task (the exact failure this addresses).
if ! aws --endpoint-url=$S3_ENDPOINT s3 cp "${REPORTFILE}" "${RESULTS_OUTPUT_S3_PATH}/${REPORTFILE}"; then
  echo "ERROR: failed to publish ${REPORTFILE} to ${RESULTS_OUTPUT_S3_PATH}" >&2
  exit 1
fi
if ! aws --endpoint-url=$S3_ENDPOINT s3 cp "${JM_REPORTS}" "${RESULTS_OUTPUT_S3_PATH}" --recursive; then
  echo "ERROR: failed to publish the report dashboard to ${RESULTS_OUTPUT_S3_PATH}" >&2
  exit 1
fi

# End-of-run summary. xtrace off so it stands out as a clean block at the tail.
set +x
echo "──────────────────────────── bng-perf-tests summary ───────────────────────────────"
echo "  run_id: ${RUN_ID:-<unset>} (environment ${ENVIRONMENT:-<unset>})"
echo "  ${SCENARIO}: RAN — report published to ${RESULTS_OUTPUT_S3_PATH}"
echo "  NOTE: red assertions in the report (project-list by design until the BMD-933 backend"
echo "        fix lands, or a slow/down frontend on the home-page group) do NOT gate the run."
echo "────────────────────────────────────────────────────────────────────────────────────"
set -x
