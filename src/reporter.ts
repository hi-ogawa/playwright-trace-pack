import { dirname, resolve } from "node:path";

import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

import { packTraces, type TraceEntry } from "./index.js";

export interface TracePackReporterOptions {
  outputFile?: string;
  title?: string;
  viewerUrl?: string;
}

export default class TracePackReporter implements Reporter {
  private readonly entries: TraceEntry[] = [];
  private rootDir = process.cwd();

  constructor(private readonly options: TracePackReporterOptions = {}) {}

  onBegin(config: FullConfig): void {
    this.rootDir = config.configFile ? dirname(config.configFile) : process.cwd();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
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
      outputFile: resolve(this.rootDir, this.options.outputFile || "playwright-traces.html"),
      title: this.options.title,
      viewerUrl: this.options.viewerUrl,
    });
  }
}
