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
# Defaults to the frontend (the home-page smoke test); backend-targeted
# scenarios (e.g. baseline-overlap-scaling) must set SERVICE_ENDPOINT to the
# backend, e.g. bng-metric-backend.<env>.cdp-int.defra.cloud.
SERVICE_ENDPOINT=${SERVICE_ENDPOINT:-bng-metric-frontend.${ENVIRONMENT}.cdp-int.defra.cloud}
# PORT is used to set the port of this performance test container
SERVICE_PORT=${SERVICE_PORT:-443}
SERVICE_URL_SCHEME=${SERVICE_URL_SCHEME:-https}

# Optional per-scenario tuning, forwarded from env vars into JMeter properties.
# Kept out of the committed .jmx so a secret BEARER_TOKEN never lands in git, and
# so each run can size its own load and target. Each is forwarded only when set;
# otherwise the .jmx property default applies. Used by the baseline-overlap-scaling
# scenario (BMD-911); a harmless no-op for scenarios that ignore these properties.
add_prop() {
  # $1 = JMeter property name, $2 = value. Skips empty values so the .jmx default
  # wins rather than being overridden with an empty string.
  if [ -n "$2" ]; then
    SCENARIO_PROPS="${SCENARIO_PROPS} -J$1=$2"
  fi
}

# cdp-uploader lives at its own host; derive a sensible per-environment default so
# the baseline-overlap-scaling scenario can drive the upload pipeline, overridable
# via UPLOADER_ENDPOINT / UPLOADER_PORT / UPLOADER_URL_SCHEME.
UPLOADER_ENDPOINT=${UPLOADER_ENDPOINT:-cdp-uploader.${ENVIRONMENT}.cdp-int.defra.cloud}
UPLOADER_PORT=${UPLOADER_PORT:-443}
UPLOADER_URL_SCHEME=${UPLOADER_URL_SCHEME:-https}

# Assemble with xtrace OFF so `set -x` never echoes BEARER_TOKEN into the CDP
# logs. JWTs, hostnames and the numeric tunables contain no whitespace, so
# leaving ${SCENARIO_PROPS} unquoted to word-split into separate args is safe.
set +x
SCENARIO_PROPS=""
add_prop bearerToken "${BEARER_TOKEN}"
add_prop uploaderDomain "${UPLOADER_ENDPOINT}"
add_prop uploaderPort "${UPLOADER_PORT}"
add_prop uploaderProtocol "${UPLOADER_URL_SCHEME}"
# Fixtures are baked into the image beside the scenarios; point the plan at them.
add_prop fixtureDir "${FIXTURE_DIR:-${JM_SCENARIOS}/fixtures}"
add_prop s3Bucket "${UPLOAD_S3_BUCKET}"
add_prop fixtureSmall "${FIXTURE_SMALL}"
add_prop fixtureLarge "${FIXTURE_LARGE}"
add_prop threads "${PERF_THREADS}"
add_prop rampSeconds "${PERF_RAMP_SECONDS}"
add_prop loops "${PERF_LOOPS}"
add_prop validateMaxMsSmall "${VALIDATE_MAX_MS_SMALL}"
add_prop validateMaxMsLarge "${VALIDATE_MAX_MS_LARGE}"
add_prop uploadMaxMs "${UPLOAD_MAX_MS}"

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
