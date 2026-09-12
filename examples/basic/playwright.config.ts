import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: true,
  use: {
    ...devices["Desktop Chrome"],
    channel: "chromium",
    trace: "on",
    viewport: { width: 900, height: 600 },
  },
  reporter: [["line"], ["../../src/reporter.ts"]],
});
