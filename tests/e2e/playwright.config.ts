import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: {
    // Use a pre-built binary (SERVER_BIN) when available, e.g. in Docker
    command: process.env.SERVER_BIN ? process.env.SERVER_BIN : 'cargo run',
    cwd: '../..',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Every worker shares one server on 127.0.0.1, so the per-IP limits
      // apply to the whole suite at once and uploads start returning 429 as
      // specs are added. The limiter itself is covered by the Rust tests
      // (upload_rate_limited_429), not from here.
      RATE_LIMIT_UPLOADS_PER_MIN: '0',
      RATE_LIMIT_LOOKUPS_PER_MIN: '0',
    },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
