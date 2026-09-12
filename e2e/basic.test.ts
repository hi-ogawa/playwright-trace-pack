import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleDirectory = resolve(repositoryRoot, "examples/basic");
const outputFile = resolve(exampleDirectory, "test-results/trace-pack.html");
const testResults = resolve(exampleDirectory, "test-results");

test("reporter follows the command-line output directory", async ({}, testInfo) => {
  const outputDir = testInfo.outputPath("custom-results");
  const playwrightCli = resolve(repositoryRoot, "node_modules/@playwright/test/cli.js");
  await execFileAsync(
    process.execPath,
    [
      playwrightCli,
      "test",
      "--config",
      resolve(exampleDirectory, "playwright.config.ts"),
      "--output",
      outputDir,
    ],
    { cwd: repositoryRoot },
  );

  const html = await readFile(resolve(outputDir, "trace-pack.html"), "utf8");
  expect(html).toContain("edits a todo list");
  expect(html).toContain("captures network and console activity");
});

test("example fixture generates and opens a trace pack", async ({ page }) => {
  await rm(outputFile, { force: true });
  await rm(testResults, { force: true, recursive: true });

  const playwrightCli = resolve(repositoryRoot, "node_modules/@playwright/test/cli.js");
  await execFileAsync(
    process.execPath,
    [playwrightCli, "test", "--config", resolve(exampleDirectory, "playwright.config.ts")],
    { cwd: repositoryRoot },
  );

  const html = await readFile(outputFile, "utf8");
  expect(html).toContain("edits a todo list");
  expect(html).toContain("captures network and console activity");

  await page.goto(pathToFileURL(outputFile).href);

  const traceButtons = page.locator("#traces .trace");
  await expect(traceButtons).toHaveCount(2);
  await expect(page.locator("#status")).toHaveText("Select a trace from the sidebar.");
  expect(new URL(page.url()).searchParams.has("trace")).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => window.innerWidth),
  );

  const sidebar = page.locator("#sidebar");
  const resizer = page.locator("#sidebar-resizer");
  const resizerBox = await resizer.boundingBox();
  expect(resizerBox).not.toBeNull();
  await page.mouse.move(resizerBox!.x + 2, resizerBox!.y + 20);
  await page.mouse.down();
  await page.mouse.move(360, resizerBox!.y + 20);
  await page.mouse.up();
  expect((await sidebar.boundingBox())!.width).toBe(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => window.innerWidth),
  );

  const titles = await traceButtons.locator(".trace-title").allTextContents();
  const todoIndex = titles.findIndex((title) => title.includes("edits a todo list"));
  const networkIndex = titles.findIndex((title) =>
    title.includes("captures network and console activity"),
  );
  expect(todoIndex).not.toBe(-1);
  expect(networkIndex).not.toBe(-1);

  const viewer = page.frameLocator("#viewer");
  await traceButtons.nth(todoIndex).click();
  await expect(viewer.getByText('Fill "Share one HTML file"', { exact: true })).toBeVisible();
  const todoTraceId = await traceButtons.nth(todoIndex).getAttribute("data-trace-id");
  expect(new URL(page.url()).searchParams.get("trace")).toBe(todoTraceId);

  await page.reload();
  await expect(viewer.getByText('Fill "Share one HTML file"', { exact: true })).toBeVisible();

  await traceButtons.nth(networkIndex).click();
  await expect(viewer.getByText("Navigate", { exact: true }).first()).toBeVisible();
  const networkTraceId = await traceButtons.nth(networkIndex).getAttribute("data-trace-id");
  expect(new URL(page.url()).searchParams.get("trace")).toBe(networkTraceId);
  await viewer.getByText("After", { exact: true }).first().click();
  await expect(viewer.locator("iframe").first()).toBeAttached();
});
