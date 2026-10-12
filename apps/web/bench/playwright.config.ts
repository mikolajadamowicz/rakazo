import { defineConfig, devices } from "@playwright/test";

// The web performance benchmark (docs/performance.md); not part of the e2e suite.
const executablePath = process.env.BENCH_CHROMIUM_PATH;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.bench\.ts/,
  timeout: 900_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5190" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
});
