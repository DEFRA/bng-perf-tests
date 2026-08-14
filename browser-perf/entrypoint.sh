#!/bin/sh
# CDP entrypoint for the browser-driven BMD-911 perf test. Runs the Playwright
# scenario, then publishes the report to the CDP results bucket. Exits with the
# TEST's status so the fail-by-design assertion (unfixed backend) surfaces as a
# failed run; a publish problem only warns.
set -e
echo "run_id: ${RUN_ID} in ${ENVIRONMENT}"
set +e

npm run perf
test_exit_code=$?

./bin/publish-results.sh
publish_exit_code=$?
if [ "$publish_exit_code" -ne 0 ]; then
  echo "WARNING: failed to publish perf results (exit ${publish_exit_code})"
fi

if [ "$test_exit_code" -eq 0 ]; then
  echo "perf test passed"
else
  echo "perf test failed (exit ${test_exit_code}) — see the scaling ratio in the log/report above"
fi
exit $test_exit_code
