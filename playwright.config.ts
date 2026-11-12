import { defineConfig, devices } from "@playwright/test";

/**
 * Check harness of the showcase: a tiny static server (``scripts/serve.mjs``)
 * puts the host page build (``dist``) and a DataLab Web build under the
 * same origin, as on datalab-platform.com:
 *
 *   /web-showcase/  ->  dist (``npm run build`` first)
 *   /web/           ->  $DATALAB_WEB_DIST (default ``.datalab-web/dist``)
 *
 * ``npm run showcase:check`` plays every demo in check mode (speed 0);
 * ``npm run showcase:headed`` plays them on screen, at the normal pace.
 */

const PORT = Number(process.env.SHOWCASE_PORT ?? 4191);
const WEB_DIST = process.env.DATALAB_WEB_DIST ?? ".datalab-web/dist";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node scripts/serve.mjs --port ${PORT} --web-dist "${WEB_DIST}"`,
    url: `http://localhost:${PORT}/web-showcase/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: "showcase-check",
      testMatch: /showcase\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1600, height: 900 },
      },
    },
    {
      name: "showcase-headed",
      testMatch: /headed\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        headless: false,
        viewport: { width: 1600, height: 900 },
      },
    },
  ],
});
