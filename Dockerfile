FROM defradigital/cdp-perf-test-docker:latest

WORKDIR /opt/perftest

# The base image (alpine/jmeter) ships no Node. entrypoint.sh mints a real
# cdp-defra-id-stub token via scripts/get-stub-token.mjs before JMeter runs — the
# DEFRA perf-test pattern (see trade-demo-perf-tests) — so add a Node runtime.
USER root
RUN apk add --no-cache nodejs

# The upload scenarios generate their GeoPackage fixtures at run time with
# bng-library (scripts/make-gpkg.mjs), so its dependencies must be baked in.
# npm and git are build-time only — git because bng-library is pinned to a
# GitHub SHA rather than published to a registry — so they are installed as a
# virtual package and removed once node_modules exists.
#
# --ignore-scripts is required, not belt-and-braces: npm runs a `prepare` step
# for git dependencies, which installs bng-library's devDependencies and tries
# to build better-sqlite3 from source in an image with no toolchain
# (npm/cli#9005). The same workaround is in bng-metric-backend's Dockerfile.
# better-sqlite3 v13 ships its prebuilt binary in the tarball, so skipping
# install scripts costs nothing.
#
# This resolves at image-build time on the GitHub Actions runner
# (DEFRA/cdp-build-action), so a CDP task pulls a finished image and needs no
# access to GitHub or the npm registry.
COPY package.json package-lock.json ./
RUN apk add --no-cache --virtual .build-deps npm git \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && apk del .build-deps

COPY scenarios/ ./scenarios/
COPY scripts/ ./scripts/
COPY entrypoint.sh .
COPY user.properties .

ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
# The base image (defradigital/cdp-perf-test-docker) bakes in ENV TEST_SCENARIO=test
# for its own sample test.jmx, which we do not ship. Clear it so an unset value means
# "run the default scenarios/bng-perf.jmx plan"; set TEST_SCENARIO=<name> on the CDP
# task to point at a different scenarios/<name>.jmx.
ENV TEST_SCENARIO=""

ENTRYPOINT [ "./entrypoint.sh" ]
