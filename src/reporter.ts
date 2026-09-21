import { dirname, relative, resolve } from "node:path";

import type { FullConfig, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";

import { packTraces, type PackOptions, type TraceEntry } from "./index.js";

export interface TracePackReporterOptions {
  outputFile?: string;
  excludeResponseBody?: PackOptions["excludeResponseBody"];
  title?: string;
  viewerUrl?: string;
}

export default class TracePackReporter implements Reporter {
  private readonly entries: TraceEntry[] = [];
  private rootDir = process.cwd();
  private testOrder = new Map<string, number>();
  private outputFile = resolve("test-results", "trace-pack.html");

  constructor(private readonly options: TracePackReporterOptions = {}) {}

  onBegin(config: FullConfig, suite: Suite): void {
    this.rootDir = config.rootDir;
    this.testOrder = new Map(suite.allTests().map((test, index) => [test.id, index]));
    const configDir = config.configFile ? dirname(config.configFile) : process.cwd();
    this.outputFile = this.options.outputFile
      ? resolve(configDir, this.options.outputFile)
      : resolve(
          config.projects[0]?.outputDir || resolve(configDir, "test-results"),
          "trace-pack.html",
        );
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const retry = result.retry ? ` · retry ${result.retry}` : "";
    const title = `${test.titlePath().filter(Boolean).join(" › ")}${retry}`;

    const suites: string[] = [];
    for (let parent: Suite | undefined = test.parent; parent; parent = parent.parent) {
      if (parent.type === "describe") suites.unshift(parent.title);
    }

    for (const attachment of result.attachments) {
      if (attachment.name !== "trace" || (!attachment.path && !attachment.body)) continue;
      this.entries.push({
        data: attachment.body,
        path: attachment.path,
        title,
        test: {
          id: test.id,
          project: test.parent.project()?.name ?? "",
          file: relative(this.rootDir, test.location.file).split("\\").join("/"),
          titlePath: [...suites, test.title],
          order: this.testOrder.get(test.id) ?? 0,
          retry: result.retry,
        },
      });
    }
  }

  async onEnd(): Promise<void> {
    if (!this.entries.length) return;

    await packTraces(this.entries, {
      outputFile: this.outputFile,
      excludeResponseBody: this.options.excludeResponseBody,
      title: this.options.title,
      viewerUrl: this.options.viewerUrl,
    });
  }
}
