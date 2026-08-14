import { defineConfig } from '@playwright/test'

import { baseUrl, proxyConfig } from './env.js'

// Single browser-driven perf test. No retries — a perf measurement must not be
// silently re-run — and a long per-test timeout because it does two full
// upload+validate cycles, the large one deliberately slow against an unfixed
// backend. Results are written as JSON + HTML for the S3 publish step.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60 * 1000,
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/results.json' }],
    ['html', { outputFolder: 'reports/html', open: 'never' }]
  ],
  use: {
    baseURL: baseUrl,
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
    ignoreHTTPSErrors: false,
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Force HTTP/1.1 through the CDP egress proxy (avoids
        // ERR_HTTP2_PROTOCOL_ERROR on the external Defra ID login) — same
        // workaround the journey-tests apply.
        ...(proxyConfig ? ['--disable-http2'] : [])
      ]
    }
  }
})
