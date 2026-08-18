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

# Seed baseline projects through the backend API before the authenticated
# scenarios run, so read scenarios (e.g. project-list-payload) have data to
# exercise on any environment — no DB access needed. Set SEED_VIA_API=false to
# skip (e.g. when the target is already seeded by other means).
SEED_VIA_API=${SEED_VIA_API:-true}
SEED_DONE=false

# Discover every scenarios/*.jmx into RUN by basename — the default run, and the
# fallback when a requested scenario cannot be resolved.
all_scenarios() {
  found=""
  for f in ${JM_SCENARIOS}/*.jmx; do
    [ -e "${f}" ] || continue
    found="${found} $(basename "${f}" .jmx)"
  done
  echo "${found}"
}

# Which suites to run. Default: EVERY scenarios/*.jmx, so a single CDP task
# exercises the whole suite. TEST_SCENARIO restricts it — one or more names,
# space- OR comma-separated, e.g. TEST_SCENARIO=project-list-payload.
#
# A requested name that has no .jmx is skipped with a warning rather than
# aborting the task, and if NONE of the requested names resolve we fall back to
# running every scenario. This keeps a stale/placeholder value on the CDP task
# (e.g. the template default TEST_SCENARIO=test) from failing the whole run.
SCENARIOS=""
if [ -n "${TEST_SCENARIO}" ]; then
  for name in $(echo "${TEST_SCENARIO}" | tr ',' ' '); do
    if [ -f "${JM_SCENARIOS}/${name}.jmx" ]; then
      SCENARIOS="${SCENARIOS} ${name}"
    else
      echo "WARNING: requested scenario '${name}.jmx' not found in ${JM_SCENARIOS} — skipping" >&2
    fi
  done
fi
# `echo` collapses whitespace, so this is true when SCENARIOS is empty or blank.
if [ -z "$(echo ${SCENARIOS})" ]; then
  if [ -n "${TEST_SCENARIO}" ]; then
    echo "WARNING: no requested scenario in TEST_SCENARIO='${TEST_SCENARIO}' resolved — running all scenarios" >&2
  fi
  SCENARIOS="$(all_scenarios)"
fi

# Mint the cdp-defra-id-stub token lazily and at most once per task — every
# authenticated scenario shares the one perf user. Sets BEARER_TOKEN (and USER_ID
# to the minted sub when unset). No-op if BEARER_TOKEN is already supplied.
mint_token_once() {
  if [ -n "${BEARER_TOKEN}" ]; then
    return 0
  fi
  # xtrace OFF so the token is never echoed into the CDP logs.
  set +x
  echo "▸ minting a cdp-defra-id-stub token from ${STUB_BASE_URL}"
  MINT_ERR=$(mktemp)
  BEARER_TOKEN=$(STUB_BASE_URL="${STUB_BASE_URL}" node "${JM_HOME}/scripts/get-stub-token.mjs" 2>"${MINT_ERR}")
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

# Seed baseline projects via the backend API at most once per task, sharing the
# one minted perf user. Idempotent to a target count (scripts/seed-via-api.mjs
# tops up to SEED_PROJECT_COUNT, never deletes), so re-runs do not pile rows up.
# $1 = backend base URL (scheme://host:port). No-op when SEED_VIA_API is not true.
seed_via_api_once() {
  api_base_url="$1"
  if [ "${SEED_VIA_API}" != "true" ] || [ "${SEED_DONE}" = "true" ]; then
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
  SEED_DONE=true
  return 0
}

add_prop() {
  # $1 = JMeter property name, $2 = value. Skips empty values so the .jmx default
  # wins rather than being overridden with an empty string.
  if [ -n "$2" ]; then
    SCENARIO_PROPS="${SCENARIO_PROPS} -J$1=$2"
  fi
}

# Publish one scenario's report + CSV under a per-scenario prefix in S3, so a
# multi-scenario run keeps every dashboard rather than overwriting a shared path.
publish_results() {
  scenario="$1"
  report_dir="$2"
  csv="$3"
  if [ -z "${RESULTS_OUTPUT_S3_PATH}" ]; then
    echo "RESULTS_OUTPUT_S3_PATH is not set — skipping S3 publish for ${scenario}"
    return 0
  fi
  if [ -f "${report_dir}/index.html" ]; then
    dest="${RESULTS_OUTPUT_S3_PATH}/${scenario}"
    aws --endpoint-url=$S3_ENDPOINT s3 cp "${csv}" "${dest}/${csv}"
    aws --endpoint-url=$S3_ENDPOINT s3 cp "${report_dir}" "${dest}" --recursive
    echo "Results for ${scenario} published to ${dest}"
    return 0
  fi
  echo "${report_dir}/index.html not found for ${scenario} — nothing to publish" >&2
  return 1
}

# Non-zero if any scenario hit an infrastructure failure (missing file, mint
# failure, no report). Assertion failures do NOT gate: project-list-payload
# encodes unshipped BMD-933 acceptance criteria and is red by design until the
# backend fix lands.
overall_status=0

for scenario in ${SCENARIOS}; do
  SCENARIOFILE=${JM_SCENARIOS}/${scenario}.jmx
  if [ ! -f "${SCENARIOFILE}" ]; then
    echo "ERROR: scenario ${scenario}.jmx not found in ${JM_SCENARIOS}" >&2
    overall_status=1
    continue
  fi

  echo "=== Scenario: ${scenario} ==="

  # Per-scenario target: a scenario that reads bearerToken drives the backend API
  # and needs a token; anything else targets the public frontend unauthenticated.
  if grep -q "__P(bearerToken" "${SCENARIOFILE}" 2>/dev/null; then
    DEFAULT_SERVICE=bng-metric-backend
    NEEDS_AUTH=true
  else
    DEFAULT_SERVICE=bng-metric-frontend
    NEEDS_AUTH=false
  fi
  DOMAIN=${SERVICE_ENDPOINT:-${DEFAULT_SERVICE}.${ENVIRONMENT}.cdp-int.defra.cloud}

  if [ "${NEEDS_AUTH}" = "true" ] && ! mint_token_once; then
    echo "ERROR: skipping ${scenario} — no stub token" >&2
    overall_status=1
    continue
  fi

  # Authenticated scenarios read the owner's data; seed it once (per task) before
  # the first such scenario runs. A seed failure gates that scenario — running it
  # against an empty owner would prove nothing.
  if [ "${NEEDS_AUTH}" = "true" ] && ! seed_via_api_once "${SERVICE_URL_SCHEME}://${DOMAIN}:${SERVICE_PORT}"; then
    echo "ERROR: skipping ${scenario} — seeding failed" >&2
    overall_status=1
    continue
  fi

  # Assemble properties with xtrace OFF so `set -x` never echoes BEARER_TOKEN.
  # JWTs and the numeric tunables contain no whitespace, so leaving
  # ${SCENARIO_PROPS} unquoted to word-split into separate args is safe.
  set +x
  SCENARIO_PROPS=""
  if [ "${NEEDS_AUTH}" = "true" ]; then
    add_prop bearerToken "${BEARER_TOKEN}"
    add_prop userId "${USER_ID}"
  fi
  add_prop threads "${LIST_THREADS}"
  add_prop rampSeconds "${LIST_RAMP_SECONDS}"
  add_prop loops "${LIST_LOOPS}"
  add_prop listSizeLimitBytes "${LIST_SIZE_LIMIT_BYTES}"
  add_prop listMaxLatencyMs "${LIST_MAX_LATENCY_MS}"
  add_prop limit "${LIST_LIMIT}"
  add_prop offset "${LIST_OFFSET}"

  REPORT_DIR=${JM_REPORTS}/${scenario}
  LOGFILE=${JM_LOGS}/perftest-${scenario}.log
  REPORTFILE=${NOW}-perftest-${scenario}-report.csv

  # -f forces JMeter to overwrite an existing results file / report folder.
  jmeter -n -t ${SCENARIOFILE} -e -l "${REPORTFILE}" -o ${REPORT_DIR} -j ${LOGFILE} -f \
  -Jenv="${ENVIRONMENT}" \
  -Jdomain="${DOMAIN}" \
  -Jport="${SERVICE_PORT}" \
  -Jprotocol="${SERVICE_URL_SCHEME}" \
  ${SCENARIO_PROPS}
  set -x

  publish_results "${scenario}" "${REPORT_DIR}" "${REPORTFILE}" || overall_status=1
done

exit ${overall_status}
