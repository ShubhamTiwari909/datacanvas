/**
 * End-to-end tests (Playwright). They drive a real browser against the REAL
 * packaged app: the fixture in e2e/fixtures.ts starts `.package/bin/datacanvas.mjs`
 * (run `npm run package` first) on a free port with a private data folder and a
 * throwaway PostgreSQL database.
 *
 * Needs DATACANVAS_TEST_PG_URL (see examples/docker-compose.yml). Run with
 * `npm run test:e2e`. One worker: each test file starts its own server.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
