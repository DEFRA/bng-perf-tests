// Runtime configuration, all from env vars so a CDP run is configured entirely
// through the Portal. Mirrors how the journey-tests resolve their e2e target and
// credentials (test/utils/env.js) — same DEFRA_ID_USERNAME / DEFRA_ID_PASSWORD
// secrets, same egress-proxy handling for the external Defra ID login.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const environment = process.env.ENVIRONMENT ?? 'dev'

// The perf test drives the FRONTEND (the browser can't hold a bearer token, so —
// like the journey-tests — we authenticate a real session and drive the UI). The
// frontend then calls the backend's /baseline/validate itself, server-side.
export const baseUrl =
  process.env.BASE_URL ??
  `https://bng-metric-frontend.${environment}.cdp-int.defra.cloud`

// Which login flow to drive. 'real' = Government Gateway (perf-test and other
// real-B2C CDP envs); 'stub' = the cdp-defra-id-stub registration flow (local
// dev, whose login pages differ from real Defra ID). Auto-selected from the
// target — a localhost frontend implies the stub — unless PERF_LOGIN_MODE forces
// it. This is the same two-mode split the journey-tests use (RUN_MODE=e2e vs not).
const isLocalTarget = /localhost|127\.0\.0\.1|\[::1\]/i.test(baseUrl)
export const loginMode =
  process.env.PERF_LOGIN_MODE ?? (isLocalTarget ? 'stub' : 'real')

// Real Defra ID test-account credentials (real mode only) — the SAME secret
// names the journey tests use, injected via the CDP Portal secret store. The
// account must have the BNG completer role and no MFA (Government Gateway login
// is scripted, not interactive-with-a-second-factor).
export const defraIdUsername = process.env.DEFRA_ID_USERNAME
export const defraIdPassword = process.env.DEFRA_ID_PASSWORD

// Stub mode (local) config: the cdp-defra-id-stub base and a per-run user so
// re-runs don't collide. Registered with the BNG completer role in flows.js.
export const stubBaseUrl =
  process.env.STUB_BASE_URL ?? 'http://localhost:3200/cdp-defra-id-stub'
export const stubUserEmail =
  process.env.STUB_USER_EMAIL ?? `bng-perf-${Date.now()}@example.com`

// The external Defra ID (Azure B2C / Government Gateway) pages are reached
// through the platform egress proxy; internal CDP URLs and localhost go direct.
const proxyServer = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
export const proxyConfig = proxyServer
  ? { server: proxyServer, bypass: 'localhost,127.0.0.1,.cdp-int.defra.cloud' }
  : undefined

// The two committed git-LFS fixtures, reused from the JMeter scenario's dir.
// Sizes chosen so 2N is a clean doubling of N — the scaling read (see the spec).
export const fixtures = {
  small: {
    label: process.env.PERF_LABEL_SMALL ?? '1000 parcels',
    path: path.resolve(
      here,
      '..',
      'scenarios',
      'fixtures',
      process.env.FIXTURE_SMALL ?? 'baseline-overlap-1000.gpkg'
    )
  },
  large: {
    label: process.env.PERF_LABEL_LARGE ?? '2000 parcels',
    path: path.resolve(
      here,
      '..',
      'scenarios',
      'fixtures',
      process.env.FIXTURE_LARGE ?? 'baseline-overlap-2000.gpkg'
    )
  }
}

const toNumber = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

// The BMD-911 gate. A quadratic curve roughly QUADRUPLES from N to 2N; a linear
// (post-fix) curve roughly DOUBLES. Allow headroom over 2x for real-infra noise
// and the ~constant scan-settle offset baked into the measured request, but stay
// well under 4x so an unfixed backend fails.
export const scalingRatioMax = toNumber(process.env.SCALING_RATIO_MAX, 3.0)

// Optional absolute budget on the large validate step (ms). 0 disables it — the
// scaling ratio is the primary, machine-independent gate.
export const validateMaxMsLarge = toNumber(process.env.VALIDATE_MAX_MS_LARGE, 0)
