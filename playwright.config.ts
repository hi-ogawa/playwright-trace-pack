import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chromium",
  },
});
