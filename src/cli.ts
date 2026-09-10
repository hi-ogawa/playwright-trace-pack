#!/usr/bin/env node

import { basename, relative, resolve } from "node:path";

import { findTraceFiles, packTraces } from "./index.js";

interface CliOptions {
  inputs: string[];
  outputFile?: string;
  title?: string;
  viewerUrl?: string;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (!options.inputs.length) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const files = await findTraceFiles(options.inputs);
  if (!files.length) throw new Error("No Playwright trace ZIP files found");

  const outputFile = resolve(options.outputFile || defaultOutputFile(files));
  await packTraces(
    files.map((path) => ({
      path,
      title: relative(process.cwd(), path),
    })),
    {
      outputFile,
      title: options.title,
      viewerUrl: options.viewerUrl,
    },
  );

  console.log(
    `Packed ${files.length} trace${files.length === 1 ? "" : "s"} into ${relative(process.cwd(), outputFile) || basename(outputFile)}`,
  );
}

function parseArguments(arguments_: string[]): CliOptions {
  const options: CliOptions = { inputs: [] };

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "-h" || argument === "--help") {
      printHelp();
      process.exit(0);
    }
    if (argument === "-o" || argument === "--output") {
      options.outputFile = requireValue(arguments_, ++index, argument);
      continue;
    }
    if (argument === "--title") {
      options.title = requireValue(arguments_, ++index, argument);
      continue;
    }
    if (argument === "--viewer") {
      options.viewerUrl = requireValue(arguments_, ++index, argument);
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    options.inputs.push(argument);
  }

  return options;
}

function requireValue(arguments_: string[], index: number, option: string): string {
  const value = arguments_[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function defaultOutputFile(files: string[]): string {
  if (files.length === 1) return files[0].replace(/\.zip$/i, ".html");
  return "playwright-traces.html";
}

function printHelp(): void {
  console.log(`Usage: playwright-trace-pack [options] <trace.zip|directory...>

Pack one or more Playwright trace ZIP files into a single HTML file.

Options:
  -o, --output <file>  Output HTML file
  --title <title>      Document and sidebar title
  --viewer <url>       Trace Viewer URL
  -h, --help           Show this help`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
