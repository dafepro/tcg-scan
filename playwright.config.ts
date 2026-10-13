import { defineConfig, devices } from "@playwright/test";

const testPort = Number(process.env.PLAYWRIGHT_TEST_PORT ?? "4173");
if (!Number.isInteger(testPort) || testPort < 1024 || testPort > 65535)
  throw new Error(
    "PLAYWRIGHT_TEST_PORT must be an integer between 1024 and 65535.",
  );
const testOrigin = `http://127.0.0.1:${testPort}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: testOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: process.env.CI
      ? `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${testPort} --strictPort`
      : `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${testPort} --strictPort`,
    url: testOrigin,
    reuseExistingServer: false,
  },
});
