#!/usr/bin/env node
// Mint the stub users the rate-limit profile needs: one for each thread of its
// widest phase, so each thread is its own user and the backend's limit for
// each user applies as it does to real users (BMD-1203).
//
// For each user this reuses the two scripts the suite already has, unchanged:
//   - get-stub-token.mjs registers the user in the cdp-defra-id-stub and mints
//     its token (PERF_USER_EMAIL names the user);
//   - seed-via-api.mjs gives the user one small project with a baseline, which
//     the PDF report needs (SEED_PROJECT_COUNT=1, a small byte budget).
// It then reads the project's id back from GET /projects.
//
// Writes `<token>,<projectId>` lines to RATE_LIMIT_USERS_CSV and prints
// `rateLimitUsersCsv=<path>` on stdout, which entrypoint.sh turns into a
// JMeter property. Tokens never go to stderr or the log.
//
// Env:
//   API_BASE_URL           backend base URL (required)
//   RATE_LIMIT_USER_COUNT  how many users (required; ladders.sh has it)
//   RATE_LIMIT_USERS_CSV   where to write (default stage/rate-limit-users.csv)
//   STUB_BASE_URL, OIDC_REDIRECT_URI, STUB_ISSUER_HOST — passed to get-stub-token.mjs

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SCRIPTS = import.meta.dirname;
const ERROR_SNIPPET_MAX = 300;

/** Small, so seeding a user costs a moment rather than a large document. */
const PROJECT_BYTE_BUDGET = 20_000;

const note = (msg) => process.stderr.write(`${msg}\n`);

/** The stub email of rate-limit user `index` (1-based). Stable across runs. */
export function rateLimitUserEmail(index) {
  return `bng-perf-rate-limit-${index}@bng.example.com`;
}

/** A whole number of users from an environment value, or null. */
export function parseUserCount(raw) {
  const count = Number(raw);
  return Number.isInteger(count) && count > 0 ? count : null;
}

/**
 * The id of the first project with a baseline in a GET /projects body, or
 * null. The list is an array or `{ projects }`, as seed-via-api.mjs reads it.
 */
export function baselineProjectId(body) {
  const projects = Array.isArray(body) ? body : (body?.projects ?? []);
  const withBaseline = projects.find(
    (project) =>
      project?.has_baseline === true ||
      (project?.baseline?.habitats?.length ?? 0) > 0 ||
      (project?.project?.baseline?.habitats?.length ?? 0) > 0,
  );
  return withBaseline?.id ?? null;
}

/** One CSV line. Tokens and UUIDs hold no commas or quotes. */
export function csvLine(token, projectId) {
  if (/[,\s"]/.test(token) || /[,\s"]/.test(projectId)) {
    throw new Error("a token or project id holds a comma, a quote or a space");
  }
  return `${token},${projectId}`;
}

function runScript(name, env) {
  const result = spawnSync(process.execPath, [join(SCRIPTS, name)], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${name} failed: ${(result.stderr ?? "").slice(-ERROR_SNIPPET_MAX)}`,
    );
  }
  return result.stdout;
}

async function projectIdFor(apiBaseUrl, token) {
  const res = await fetch(`${apiBaseUrl}/projects`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`GET /projects returned HTTP ${res.status}`);
  }
  const projectId = baselineProjectId(await res.json());
  if (!projectId) {
    throw new Error("the user has no project with a baseline after seeding");
  }
  return projectId;
}

async function main() {
  const apiBaseUrl = process.env.API_BASE_URL;
  const count = parseUserCount(process.env.RATE_LIMIT_USER_COUNT);
  const out =
    process.env.RATE_LIMIT_USERS_CSV ??
    join(SCRIPTS, "..", "stage", "rate-limit-users.csv");
  if (!apiBaseUrl) {
    throw new Error("API_BASE_URL is required");
  }
  if (!count) {
    throw new Error("RATE_LIMIT_USER_COUNT must be a whole number above 0");
  }

  const rows = [];
  for (let index = 1; index <= count; index += 1) {
    const email = rateLimitUserEmail(index);
    note(`▸ rate-limit-users: user ${index} of ${count} (${email})`);
    const token = runScript("get-stub-token.mjs", {
      PERF_USER_EMAIL: email,
    }).trim();
    runScript("seed-via-api.mjs", {
      API_BASE_URL: apiBaseUrl,
      BEARER_TOKEN: token,
      SEED_PROJECT_COUNT: "1",
      SEED_BYTE_BUDGET: String(PROJECT_BYTE_BUDGET),
    });
    rows.push(csvLine(token, await projectIdFor(apiBaseUrl, token)));
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${rows.join("\n")}\n`, { mode: 0o600 });
  note(`▸ rate-limit-users: wrote ${rows.length} user(s) to ${out}`);
  process.stdout.write(`rateLimitUsersCsv=${out}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    note(`✗ rate-limit-users: ${error.message}`);
    process.exit(1);
  });
}
