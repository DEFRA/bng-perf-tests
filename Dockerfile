FROM defradigital/cdp-perf-test-docker:latest

WORKDIR /opt/perftest

# The base image (alpine/jmeter) ships no Node. entrypoint.sh mints a real
# cdp-defra-id-stub token via scripts/get-stub-token.mjs before JMeter runs — the
# DEFRA perf-test pattern (see trade-demo-perf-tests) — so add a Node runtime.
USER root
RUN apk add --no-cache nodejs

COPY scenarios/ ./scenarios/
COPY scripts/ ./scripts/
COPY entrypoint.sh .
COPY user.properties .

ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
# entrypoint.sh runs the single scenarios/bng-perf.jmx plan by default. Override
# with TEST_SCENARIO=<name> to point at a different scenarios/<name>.jmx.

ENTRYPOINT [ "./entrypoint.sh" ]
