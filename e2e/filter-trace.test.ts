import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { filterTrace } from "../src/filter-trace.js";
import { packTraces } from "../src/index.js";

const networkEvent = (url: string, hash: string) => ({
  type: "resource-snapshot",
  snapshot: {
    request: { url },
    response: { status: 200, content: { mimeType: "application/octet-stream", _sha1: hash } },
  },
});
const jsonLines = (events: unknown[]) =>
  strToU8(events.map((event) => JSON.stringify(event)).join("\n") + "\n");

test("removes selected bodies while preserving metadata and shared resources", () => {
  const data = zipSync({
    "0.network": jsonLines([
      networkEvent("https://example.test/remove.sf2", "removed"),
      networkEvent("https://example.test/shared.sf2", "shared"),
      networkEvent("https://example.test/snapshot.sf2", "snapshot"),
      networkEvent("https://example.test/attachment.sf2", "attachment"),
    ]),
    "1.network": jsonLines([networkEvent("https://example.test/keep.bin", "shared")]),
    "0.trace": jsonLines([
      { type: "frame-snapshot", snapshot: { resourceOverrides: [{ sha1: "snapshot" }] } },
    ]),
    "test.trace": jsonLines([{ attachments: [{ sha1: "attachment" }] }]),
    "resources/removed": strToU8("remove me"),
    "resources/shared": strToU8("shared response"),
    "resources/snapshot": strToU8("snapshot resource"),
    "resources/attachment": strToU8("attachment resource"),
  });
  const original = data.slice();
  const result = unzipSync(filterTrace(data, ({ url }) => url.endsWith(".sf2")));
  expect(data).toEqual(original);
  expect(result["resources/removed"]).toBeUndefined();
  for (const name of ["shared", "snapshot", "attachment"])
    expect(result[`resources/${name}`]).toBeDefined();
  const events = strFromU8(result["0.network"])
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events).toHaveLength(4);
  for (const event of events) {
    expect(event.snapshot.response.status).toBe(200);
    expect(event.snapshot.response.content._sha1).toBeUndefined();
  }
  expect(result["0.trace"]).toEqual(unzipSync(original)["0.trace"]);
});

test("preserves shared resources referenced by newer trace file paths", () => {
  const events = [
    networkEvent("https://example.test/remove.sf2", "shared"),
    networkEvent("https://example.test/keep.bin", "shared"),
  ].map((event) => ({
    ...event,
    snapshot: {
      ...event.snapshot,
      response: { content: { _file: "resources/shared", mimeType: "application/octet-stream" } },
    },
  }));
  const result = unzipSync(
    filterTrace(
      zipSync({
        "trace.network": jsonLines(events),
        "resources/shared": strToU8("shared body"),
      }),
      ({ url }) => url.endsWith(".sf2"),
    ),
  );
  const filtered = strFromU8(result["trace.network"])
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(filtered[0].snapshot.response.content._file).toBeUndefined();
  expect(filtered[1].snapshot.response.content._file).toBe("resources/shared");
  expect(strFromU8(result["resources/shared"])).toBe("shared body");
});

test("supports inline bodies and leaves an unmatched ZIP unchanged", () => {
  const data = zipSync({
    "0.network": jsonLines([
      {
        type: "resource-snapshot",
        snapshot: {
          request: { url: "https://example.test/inline" },
          response: { content: { mimeType: "text/plain", text: "payload", encoding: "base64" } },
        },
      },
    ]),
  });
  expect(filterTrace(data, () => false)).toBe(data);
  const result = unzipSync(filterTrace(data, ({ mimeType }) => mimeType === "text/plain"));
  const event = JSON.parse(strFromU8(result["0.network"]).trim());
  expect(event.snapshot.response.content).toEqual({ mimeType: "text/plain" });
});

test("filtered trace keeps styled DOM snapshots in the official viewer", async ({
  browser,
  page,
}, testInfo) => {
  // Record a page that loads a large soundfont alongside its visual resources.
  const context = await browser.newContext();
  await context.tracing.start({ snapshots: true });
  const recorded = await context.newPage();
  await recorded.route("https://example.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/sound.sf2") {
      await route.fulfill({
        contentType: "application/octet-stream",
        body: randomBytes(256 * 1024),
      });
    } else if (path === "/style.css") {
      await route.fulfill({ contentType: "text/css", body: "h1 { color: rgb(12, 34, 56); }" });
    } else if (path === "/image.svg") {
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="red"/></svg>',
      });
    } else {
      await route.fulfill({
        contentType: "text/html",
        body: '<link rel="stylesheet" href="/style.css"><h1>Loading</h1><img src="/image.svg"><script>fetch("/sound.sf2").then(r => r.arrayBuffer()).then(() => document.querySelector("h1").textContent = "Ready")</script>',
      });
    }
  });
  await recorded.goto("https://example.test/");
  await recorded.getByRole("heading", { name: "Ready" }).click();
  const trace = testInfo.outputPath("trace.zip");
  await context.tracing.stop({ path: trace });
  await context.close();

  // Pack only a filtered copy and verify the soundfont accounts for the size reduction.
  const original = await readFile(trace);
  const htmlPath = testInfo.outputPath("filtered.html");
  await packTraces([{ path: trace }], {
    outputFile: htmlPath,
    excludeResponseBody: ({ url }) => new URL(url).pathname.endsWith(".sf2"),
  });
  const html = await readFile(htmlPath, "utf8");
  const encoded = JSON.parse(html.match(/const traces = (.*)/)![1])[0].base64;
  const filtered = Buffer.from(encoded, "base64");
  expect(original.length - filtered.length).toBeGreaterThan(200 * 1024);
  const archive = unzipSync(filtered);
  const network = strFromU8(archive["trace.network"])
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const soundfont = network.find((event) => event.snapshot.request.url.endsWith("/sound.sf2"));
  expect(soundfont.snapshot.response.content._file).toBeUndefined();
  expect(soundfont.snapshot.response.content._sha1).toBeUndefined();
  expect(Object.values(archive).some((bytes) => bytes.length === 256 * 1024)).toBe(false);
  expect(await readFile(trace)).toEqual(original);

  // Open the filtered trace and inspect its recorded heading and image.
  await page.goto(pathToFileURL(htmlPath).href);
  await page.getByRole("button", { name: "Open trace", exact: true }).click();
  const viewer = page.frameLocator("#viewer");
  await viewer.getByRole("treeitem").filter({ hasText: "Click" }).click();
  await viewer.getByText("After", { exact: true }).first().click();
  const snapshot = viewer.frameLocator("iframe").first();
  await expect(snapshot.getByRole("heading", { name: "Ready" })).toHaveCSS(
    "color",
    "rgb(12, 34, 56)",
  );
  await expect(snapshot.locator("img")).toHaveJSProperty("naturalWidth", 40);
  await page.screenshot({ path: testInfo.outputPath("filtered-viewer.png") });
});
