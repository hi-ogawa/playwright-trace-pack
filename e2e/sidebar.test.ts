import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

import { packTraces, type TraceEntry } from "../src/index.js";

function entry(project: string, file: string, id: string, order: number, retry = 0): TraceEntry {
  return {
    data: new Uint8Array([1, 2, 3]),
    title: `${project} › ${file} › suite › ${id}`,
    test: { project, file, id, order, retry, titlePath: ["suite", id] },
  };
}

test("groups projects, files, tests and attempts while preserving search and link navigation", async ({
  page,
}, info) => {
  // Deliberately supply completion order instead of declaration order.
  const outputFile = info.outputPath("nested.html");
  await packTraces(
    [
      entry("chromium", "b.spec.ts", "last", 2),
      entry("firefox", "a.spec.ts", "other", 3),
      entry("chromium", "a.spec.ts", "second", 1, 1),
      entry("chromium", "a.spec.ts", "first", 0),
      entry("chromium", "a.spec.ts", "second", 1),
      { data: new Uint8Array([4]), title: "Unstructured CLI trace" },
    ],
    { outputFile, viewerUrl: "https://viewer.test/" },
  );
  await page.route("https://viewer.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<script>parent.postMessage({method:'ready'}, '*'); addEventListener('message', event => { if(event.data?.method === 'load') document.body.textContent = 'Trace loaded'; });</script>`,
    }),
  );
  await page.goto(pathToFileURL(outputFile).href);

  // Project groups are open, files are sorted and expanded, and plain entries remain usable.
  const projects = page.locator('[data-group-type="project"]');
  await expect(projects.locator(":scope > summary .group-label")).toHaveText([
    "chromium",
    "firefox",
  ]);
  const chromium = projects.nth(0);
  await expect(chromium).toHaveAttribute("open", "");
  const files = chromium.locator('[data-group-type="file"]');
  await expect(files.locator(":scope > summary .group-label")).toHaveText([
    "a.spec.ts",
    "b.spec.ts",
  ]);
  await expect(files.first()).toHaveAttribute("open", "");
  await expect(files.nth(1)).toHaveAttribute("open", "");
  await expect(page.locator(".trace-size")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Unstructured CLI trace/ })).toBeVisible();

  // Collapse and reopen the first file by keyboard and keep tests in declaration order with grouped retries.
  await files.first().locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  await expect(files.first()).not.toHaveAttribute("open", "");
  await page.keyboard.press("Enter");
  await expect(files.first()).toHaveAttribute("open", "");
  await expect(files.first().locator(".group-children > .trace .trace-title").first()).toHaveText(
    "suite › first",
  );
  const retryGroup = files.first().locator('[data-group-type="test"]');
  await expect(retryGroup).toHaveAttribute("open", "");
  await expect(retryGroup.locator(".trace-title")).toHaveText(["Initial attempt", "Retry 1"]);

  await files.nth(1).locator(":scope > summary").click();

  // Filter across the full path, temporarily expanding matching branches without opening a trace.
  const filter = page.getByRole("searchbox", { name: "Filter traces" });
  await filter.fill("b.spec.ts");
  await expect(page.getByRole("button", { name: /suite › last/ })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("trace")).toBe(false);
  await filter.fill("");
  await expect(files.first()).toHaveAttribute("open", "");
  await expect(files.nth(1)).not.toHaveAttribute("open", "");
  await expect(retryGroup).toHaveAttribute("open", "");
  await filter.fill("missing");
  await expect(page.locator("#traces")).toHaveText("No matching traces.");

  // Select a search result, then reopen its URL with every ancestor revealed.
  await filter.fill("last");
  await page.getByRole("button", { name: /suite › last/ }).click();
  await expect(page.frameLocator("#viewer").locator("body")).toHaveText("Trace loaded");
  await page.reload();
  await expect(page.getByRole("button", { name: /suite › last/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(files.nth(1)).toHaveAttribute("open", "");
  await expect(page.frameLocator("#viewer").locator("body")).toHaveText("Trace loaded");
});

test("keeps the sole project wrapper and searches suite names without splitting title punctuation", async ({
  page,
}, info) => {
  // Preserve literal separators and markup-like text in test titles.
  const outputFile = info.outputPath("single-project.html");
  const trace = entry("chromium", "e2e/archive.spec.ts", "round-trip › <project>", 0);
  await packTraces([trace], {
    outputFile,
    title: "Playwright traces",
    viewerUrl: "https://viewer.test/",
  });
  await page.route("https://viewer.test/**", (route) => route.fulfill({ body: "Viewer" }));
  await page.goto(pathToFileURL(outputFile).href);
  await expect(page.locator('[data-group-type="project"]')).toHaveAttribute("open", "");
  await expect(page.locator('[data-group-type="project"] > summary .group-label')).toHaveText(
    "chromium",
  );
  await expect(page.locator('[data-group-type="file"]')).toHaveCount(1);
  await page.getByRole("searchbox").fill("suite");
  await expect(page.locator(".trace-title")).toHaveText("suite › round-trip › <project>");
  await expect(page.locator(".trace-title project")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("sidebar.png") });
});
