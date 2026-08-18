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
# The base image (defradigital/cdp-perf-test-docker) bakes in ENV TEST_SCENARIO=test
# for its own sample test.jmx, which we do not ship. Clear it so an unset value means
# "run every scenarios/*.jmx"; set TEST_SCENARIO on the CDP task to restrict the run.
ENV TEST_SCENARIO=""

ENTRYPOINT [ "./entrypoint.sh" ]
