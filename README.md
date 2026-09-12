# @hiogawa/playwright-trace-pack

Pack one or more Playwright trace ZIP files into a single HTML file that opens them in the official Playwright Trace Viewer.

The trace data is embedded in the generated file. The viewer itself is loaded from `https://trace.playwright.dev`, so the result is a single-file artifact but is not available offline.

## Installation

Choose a build from [pkg.pr.new](https://pkg.pr.new/~/hi-ogawa/playwright-trace-pack) and install its preview URL:

```sh
pnpm add -D "https://pkg.pr.new/hi-ogawa/playwright-trace-pack/@hiogawa/playwright-trace-pack@<commit>"
```

Replace `<commit>` with the commit SHA shown for the build you want. Use this preview installation for both the CLI and the Playwright reporter.

## CLI

```sh
pnpm exec playwright-trace-pack test-results
```

```sh
pnpm exec playwright-trace-pack test-results/foo/trace.zip --output trace.html
```

Directories are searched recursively for files named `trace.zip` or `*.trace.zip`. When multiple traces are found, the generated page includes a searchable trace picker.

## Playwright reporter

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: {
    trace: "retain-on-failure",
  },
  reporter: [
    ["line"],
    [
      "@hiogawa/playwright-trace-pack/reporter",
      {
        outputFile: "playwright-traces.html",
      },
    ],
  ],
});
```

The reporter packs every Playwright trace attachment into the HTML file after the test run. Use Playwright’s `use.trace` option to control which traces are retained. For example, `"retain-on-failure"` keeps traces for failed tests, while `"on"` keeps traces for all tests.

## Example

Run the complete fixture to generate a multi-trace HTML file:

```sh
pnpm example
```

Then open `examples/basic/playwright-traces.html`. The fixture is described in `examples/basic/README.md`.

## GitHub Actions

```yaml
- name: Run tests
  run: pnpm playwright test

- name: Upload traces
  if: always() && hashFiles('playwright-traces.html') != ''
  uses: actions/upload-artifact@v7
  with:
    path: playwright-traces.html
    archive: false
```

This avoids wrapping the HTML artifact in another ZIP file. GitHub downloads the artifact rather than rendering the HTML, so open the downloaded file locally.

## Security

Playwright traces can contain source code, screenshots, DOM content, request data, and other sensitive information. Treat generated files with the same care as the original trace ZIP files.

The integration currently uses the Trace Viewer's Blob message protocol. This protocol exists in current Playwright versions but is not documented as a stable public API.

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```
