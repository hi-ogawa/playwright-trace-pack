import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: true,
  use: {
    trace: "on",
    viewport: { width: 900, height: 600 },
  },
  reporter: [
    ["line"],
    [
      "../../src/reporter.ts",
      {
        outputFile: "playwright-traces.html",
        title: "playwright-trace-pack example",
      },
    ],
  ],
});
