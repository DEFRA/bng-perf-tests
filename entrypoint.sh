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

TEST_SCENARIO=${TEST_SCENARIO:-home-page}
SCENARIOFILE=${JM_SCENARIOS}/${TEST_SCENARIO}.jmx
REPORTFILE=${NOW}-perftest-${TEST_SCENARIO}-report.csv
LOGFILE=${JM_LOGS}/perftest-${TEST_SCENARIO}.log

# ENVIRONMENT is set to the name of the environment the test is running in.
SERVICE_ENDPOINT=${SERVICE_ENDPOINT:-bng-metric-frontend.${ENVIRONMENT}.cdp-int.defra.cloud}
# PORT is used to set the port of this performance test container
SERVICE_PORT=${SERVICE_PORT:-443}
SERVICE_URL_SCHEME=${SERVICE_URL_SCHEME:-https}

# ── Authentication (cdp-defra-id-stub) ───────────────────────────────────────
# Scenarios that read the bearerToken property (project-list-payload, BMD-933)
# call the authenticated backend. Rather than replicate the interactive Defra ID
# login, mint a REAL token from the cdp-defra-id-stub headlessly (register ->
# authorize -> token, PKCE) — the same login the app performs. This follows the
# DEFRA trade-demo-perf-tests pattern and needs no auth-bypass code in the
# backend: the backend on this environment must simply trust stub tokens (its
# OIDC_DISCOVERY_URL points at the stub, as it already does on dev).
#
# If BEARER_TOKEN is already supplied (e.g. a pre-minted token set on the CDP
# task) it is used as-is and no minting happens.
STUB_BASE_URL=${STUB_BASE_URL:-https://cdp-defra-id-stub.${ENVIRONMENT}.cdp-int.defra.cloud/cdp-defra-id-stub}

if grep -q "__P(bearerToken" "${SCENARIOFILE}" 2>/dev/null && [ -z "${BEARER_TOKEN}" ]; then
  # Mint with xtrace OFF so the token is never echoed into the CDP logs.
  set +x
  echo "▸ minting a cdp-defra-id-stub token from ${STUB_BASE_URL}"
  MINT_ERR=$(mktemp)
  BEARER_TOKEN=$(STUB_BASE_URL="${STUB_BASE_URL}" node "${JM_HOME}/scripts/get-stub-token.mjs" 2>"${MINT_ERR}")
  MINT_STATUS=$?
  cat "${MINT_ERR}" >&2
  if [ $MINT_STATUS -ne 0 ] || [ -z "${BEARER_TOKEN}" ]; then
    rm -f "${MINT_ERR}"
    echo "ERROR: failed to mint a stub token. Is ${STUB_BASE_URL} reachable, and is the backend's OIDC_DISCOVERY_URL pointed at that stub?" >&2
    exit 1
  fi
  # The backend trusts the token sub, not the path segment, but keep USER_ID
  # consistent with the minted sub when the caller has not set one.
  if [ -z "${USER_ID}" ]; then
    USER_ID=$(sed -n 's/^sub=//p' "${MINT_ERR}")
  fi
  rm -f "${MINT_ERR}"
  set -x
fi

# Optional per-scenario tuning, forwarded from env vars into JMeter properties.
# Kept out of the committed .jmx so a secret BEARER_TOKEN never lands in git, and
# so each run can size its own load. Each is forwarded only when set; otherwise
# the .jmx property defaults apply. Used by the project-list-payload scenario
# (BMD-933); a harmless no-op for scenarios that ignore these properties.
add_prop() {
  # $1 = JMeter property name, $2 = value. Skips empty values so the .jmx default
  # wins rather than being overridden with an empty string.
  if [ -n "$2" ]; then
    SCENARIO_PROPS="${SCENARIO_PROPS} -J$1=$2"
  fi
}

# Assemble and run with xtrace OFF so `set -x` never echoes BEARER_TOKEN into the
# CDP logs. JWTs and the numeric tunables contain no whitespace, so leaving
# ${SCENARIO_PROPS} unquoted to word-split into separate args is safe.
set +x
SCENARIO_PROPS=""
add_prop bearerToken "${BEARER_TOKEN}"
add_prop userId "${USER_ID}"
add_prop threads "${LIST_THREADS}"
add_prop rampSeconds "${LIST_RAMP_SECONDS}"
add_prop loops "${LIST_LOOPS}"
add_prop listSizeLimitBytes "${LIST_SIZE_LIMIT_BYTES}"
add_prop listMaxLatencyMs "${LIST_MAX_LATENCY_MS}"
add_prop limit "${LIST_LIMIT}"
add_prop offset "${LIST_OFFSET}"

# Run the test suite
jmeter -n -t ${SCENARIOFILE} -e -l "${REPORTFILE}" -o ${JM_REPORTS} -j ${LOGFILE} -f \
-Jenv="${ENVIRONMENT}" \
-Jdomain="${SERVICE_ENDPOINT}" \
-Jport="${SERVICE_PORT}" \
-Jprotocol="${SERVICE_URL_SCHEME}" \
${SCENARIO_PROPS}
set -x

# Publish the results into S3 so they can be displayed in the CDP Portal
if [ -n "$RESULTS_OUTPUT_S3_PATH" ]; then
  # Copy the CSV report file and the generated report files to the S3 bucket
   if [ -f "$JM_REPORTS/index.html" ]; then
      aws --endpoint-url=$S3_ENDPOINT s3 cp "$REPORTFILE" "$RESULTS_OUTPUT_S3_PATH/$REPORTFILE"
      aws --endpoint-url=$S3_ENDPOINT s3 cp "$JM_REPORTS" "$RESULTS_OUTPUT_S3_PATH" --recursive
      if [ $? -eq 0 ]; then
        echo "CSV report file and test results published to $RESULTS_OUTPUT_S3_PATH"
      fi
   else
      echo "$JM_REPORTS/index.html is not found"
      exit 1
   fi
else
   echo "RESULTS_OUTPUT_S3_PATH is not set"
   exit 1
fi

exit $test_exit_code
