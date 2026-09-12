import { dirname, resolve } from "node:path";

import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import { packTraces, type TraceEntry } from "./index.js";

export interface TracePackReporterOptions {
  include?: "all" | "failed";
  outputFile?: string;
  title?: string;
  viewerUrl?: string;
}

export default class TracePackReporter implements Reporter {
  private readonly entries: TraceEntry[] = [];
  private outputFile = resolve("test-results", "trace-pack.html");

  constructor(private readonly options: TracePackReporterOptions = {}) {}

  onBegin(config: FullConfig): void {
    const configDir = config.configFile ? dirname(config.configFile) : process.cwd();
    this.outputFile = this.options.outputFile
      ? resolve(configDir, this.options.outputFile)
      : resolve(
          config.projects[0]?.outputDir || resolve(configDir, "test-results"),
          "trace-pack.html",
        );
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (
      this.options.include === "failed" &&
      (result.status === "passed" || result.status === "skipped")
    )
      return;

    const retry = result.retry ? ` · retry ${result.retry}` : "";
    const title = `${test.titlePath().filter(Boolean).join(" › ")}${retry}`;

    for (const attachment of result.attachments) {
      if (attachment.name !== "trace" || (!attachment.path && !attachment.body)) continue;
      this.entries.push({
        data: attachment.body,
        path: attachment.path,
        title,
      });
    }
  }

  async onEnd(): Promise<void> {
    if (!this.entries.length) return;

    await packTraces(this.entries, {
      outputFile: this.outputFile,
      title: this.options.title,
      viewerUrl: this.options.viewerUrl,
    });
  }
}
