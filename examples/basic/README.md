# Basic example

This fixture runs two passing Playwright tests with tracing enabled and uses the local `@hiogawa/playwright-trace-pack` reporter to create one HTML file containing both traces.

From the repository root:

```sh
pnpm example
```

Open the generated `examples/basic/playwright-traces.html` directly in a browser. The left sidebar switches between the todo interaction trace and the network activity trace.

The generated file needs an internet connection because it embeds the trace data but loads the official viewer from `trace.playwright.dev`.
