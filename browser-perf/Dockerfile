# Browser-driven CDP perf image for the BMD-911 baseline-overlap-scaling test.
# Packaged like the journey-tests' Playwright suite (node base + bundled Chromium
# + aws-cli for publishing results), because — against the real deployed stack —
# authentication requires a real Defra ID browser login, which JMeter can't do.
#
# BUILD CONTEXT MUST BE THE REPO ROOT (not this directory), so the two git-LFS
# fixtures under scenarios/fixtures can be copied in:
#
#   docker build -f browser-perf/Dockerfile -t bng-perf-browser .
#
# (and the LFS objects must be materialised first — `git lfs pull` — or the
# COPY bakes pointer files; CI does this via checkout lfs:true.)
FROM node:22-bookworm-slim

ENV TZ="Europe/London"

USER root

RUN apt-get update -qq \
    && apt-get install -qqy --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# aws-cli for publishing the perf report to the CDP results bucket.
RUN curl -sS "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o awscliv2.zip \
    && unzip -q awscliv2.zip \
    && ./aws/install \
    && rm -rf awscliv2.zip aws

WORKDIR /app

# Preserve the repo-relative layout the test expects: env.js resolves the
# fixtures at ../scenarios/fixtures from the browser-perf dir.
COPY browser-perf/ ./browser-perf/
COPY scenarios/fixtures/ ./scenarios/fixtures/

WORKDIR /app/browser-perf

# --ignore-scripts (belt-and-braces with .npmrc) blocks dependency install-time
# code execution; Chromium is fetched explicitly on the next line instead.
RUN npm install --ignore-scripts
RUN npx playwright install --with-deps chromium

ENTRYPOINT [ "./entrypoint.sh" ]
