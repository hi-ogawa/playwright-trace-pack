# @hiogawa/playwright-trace-pack

Pack one or more Playwright trace ZIP files into a single HTML file that opens them in the official Playwright Trace Viewer.

The trace data is embedded in the generated file. The viewer itself is loaded from `https://trace.playwright.dev`, so the result is a single-file artifact but is not available offline.

## Installation

Install the main branch preview from [pkg.pr.new](https://pkg.pr.new/~/hi-ogawa/playwright-trace-pack):

```sh
pnpm add -D https://pkg.pr.new/hi-ogawa/playwright-trace-pack/@hiogawa/playwright-trace-pack@main
```

Use this preview installation for both the CLI and the Playwright reporter. To select a specific build, replace `main` with a commit SHA from the pkg.pr.new page.

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
  use: { trace: "retain-on-failure" },
  reporter: [["line"], ["@hiogawa/playwright-trace-pack/reporter"]],
});
```

The reporter packs every Playwright trace attachment into `trace-pack.html` in the first configured project’s `outputDir`, normally `test-results`, after the test run. This also respects a custom output directory or Playwright’s `--output` option.

Use Playwright’s `use.trace` option to control which traces are retained. For example, `"retain-on-failure"` keeps traces for failed tests, while `"on"` keeps traces for all tests.

Reporter options are optional. Use `outputFile` to choose a different path. Relative `outputFile` paths resolve from the Playwright config directory.

## Example

Run the complete fixture to generate a multi-trace HTML file:

```sh
pnpm example
```

Then open `examples/basic/test-results/trace-pack.html`. The fixture is described in `examples/basic/README.md`.

## GitHub Actions

```yaml
- name: Run tests
  run: pnpm playwright test

- name: Upload traces
  if: always() && hashFiles('test-results/trace-pack.html') != ''
  uses: actions/upload-artifact@v7
  with:
    path: test-results/trace-pack.html
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

## Reducing trace size

If you only need DOM snapshots for visual inspection, disable the screenshot filmstrip while keeping source files for debugging:

```ts
use: {
  trace: {
    mode: "retain-on-failure",
    snapshots: true,
    screenshots: false,
    sources: true,
  },
},
```

Use `mode: "on"` to keep traces for passing tests too. Source files are typically small compared with screenshots and large downloads. These settings still record actions and network activity, so combine them with response-body filtering below to omit downloads that DOM snapshots do not need. Screenshots explicitly attached by tests are separate from the filmstrip and can still be included.

## Excluding response bodies

Large downloads such as soundfonts can dominate trace size even when they are not needed to render DOM snapshots. Filter these bodies while packing:

```ts
reporter: [
  ["line"],
  ["@hiogawa/playwright-trace-pack/reporter", {
    excludeResponseBody: ({ url, mimeType }) =>
      new URL(url).pathname.endsWith(".sf2") || mimeType === "application/wasm",
  }],
],
```

The same `excludeResponseBody` callback is available on `packTraces`. The CLI accepts a repeatable regular expression matched against the full response URL:

```sh
pnpm exec playwright-trace-pack test-results --exclude-response-body '\.sf2(?:\?|$)' --exclude-response-body '\.wasm(?:\?|$)'
```

Filtering keeps actions, DOM snapshots, and network metadata, but selected response bodies will no longer be available in the viewer. Keep CSS, images, and fonts needed by the snapshots. A resource shared with another retained response, snapshot, or attachment stays in the ZIP. Filtering changes only the embedded copy, so the original trace ZIP remains intact. Without a filter, ZIP bytes are embedded unchanged.
