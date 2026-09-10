import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    reporter: "src/reporter.ts",
  },
  dts: true,
  fixedExtension: false,
  platform: "node",
  target: "node20",
});
