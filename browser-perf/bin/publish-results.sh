#!/bin/sh
# Publish the Playwright perf report (reports/) to the CDP results bucket so it
# shows in the Portal. Mirrors the JMeter entrypoint's publish step: no-op with a
# clear message when RESULTS_OUTPUT_S3_PATH is unset (e.g. a local run), and
# honours S3_ENDPOINT for LocalStack.
if [ -z "$RESULTS_OUTPUT_S3_PATH" ]; then
  echo "RESULTS_OUTPUT_S3_PATH is not set — skipping results publish"
  exit 0
fi

if [ ! -d reports ]; then
  echo "No reports/ directory produced — the perf run did not complete"
  exit 1
fi

ENDPOINT_ARG=""
if [ -n "$S3_ENDPOINT" ]; then
  ENDPOINT_ARG="--endpoint-url $S3_ENDPOINT"
fi

# shellcheck disable=SC2086
aws $ENDPOINT_ARG s3 cp reports "$RESULTS_OUTPUT_S3_PATH" --recursive
