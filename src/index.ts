import { promises as fs } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import { filterTrace, type TraceResponse } from "./filter-trace.js";

export type { TraceResponse } from "./filter-trace.js";

export interface TraceEntry {
  data?: Uint8Array;
  path?: string;
  title?: string;
}

export interface PackOptions {
  outputFile: string;
  excludeResponseBody?: (response: TraceResponse) => boolean;
  title?: string;
  viewerUrl?: string;
}

interface EmbeddedTrace {
  base64: string;
  id: string;
  size: number;
  title: string;
}

export async function packTraces(entries: TraceEntry[], options: PackOptions): Promise<void> {
  if (!entries.length) throw new Error("At least one trace is required");

  const traces = await Promise.all(
    entries.map(async (entry, index): Promise<EmbeddedTrace> => {
      if (!entry.path && !entry.data)
        throw new Error(`Trace ${index + 1} must provide either path or data`);

      const original = entry.data ?? (await fs.readFile(resolve(entry.path!)));
      const data = options.excludeResponseBody
        ? filterTrace(original, options.excludeResponseBody)
        : original;
      const defaultTitle = entry.path
        ? relative(process.cwd(), resolve(entry.path))
        : `Trace ${index + 1}`;

      return {
        base64: Buffer.from(data).toString("base64"),
        id: `trace-${index}`,
        size: data.byteLength,
        title: entry.title || defaultTitle,
      };
    }),
  );

  const html = renderTracePack(traces, {
    title: options.title || (traces.length === 1 ? traces[0].title : "Playwright traces"),
    viewerUrl: options.viewerUrl || "https://trace.playwright.dev/",
  });

  const outputFile = resolve(options.outputFile);
  await fs.mkdir(dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, html);
}

export async function findTraceFiles(inputs: string[]): Promise<string[]> {
  const files = new Set<string>();

  async function visit(path: string, explicit: boolean): Promise<void> {
    const absolutePath = resolve(path);
    const stat = await fs.stat(absolutePath);
    if (stat.isFile()) {
      if (explicit || isTraceFile(absolutePath)) files.add(absolutePath);
      return;
    }
    if (!stat.isDirectory()) return;

    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    await Promise.all(entries.map((entry) => visit(resolve(absolutePath, entry.name), false)));
  }

  await Promise.all(inputs.map((input) => visit(input, true)));
  return [...files].sort();
}

function isTraceFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "trace.zip" || name.endsWith(".trace.zip");
}

function renderTracePack(
  traces: EmbeddedTrace[],
  options: { title: string; viewerUrl: string },
): string {
  const viewerUrl = new URL(options.viewerUrl);
  if (
    viewerUrl.protocol !== "https:" &&
    !(viewerUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(viewerUrl.hostname))
  )
    throw new Error("Viewer URL must use HTTPS or local HTTP");

  const serializedTraces = serializeForInlineScript(traces);
  const serializedTitle = serializeForInlineScript(options.title);
  const serializedViewerUrl = serializeForInlineScript(viewerUrl.toString());
  const serializedViewerOrigin = serializeForInlineScript(viewerUrl.origin);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style>
    :root { --sidebar-width: 280px; color-scheme: light dark; font-family: system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body, #app { width: 100%; height: 100%; margin: 0; }
    body { overflow: hidden; background: Canvas; color: CanvasText; }
    #app { display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); overflow: hidden; }
    #sidebar { position: relative; display: flex; min-width: 0; overflow: hidden; flex-direction: column; border-right: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
    #sidebar h1 { margin: 0; padding: 16px; overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
    #filter { margin: 0 12px 10px; padding: 7px 9px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 5px; background: Canvas; color: CanvasText; }
    #traces { min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 0 8px 12px; }
    .trace { width: 100%; padding: 9px; border: 0; border-radius: 5px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
    .trace:hover { background: color-mix(in srgb, CanvasText 8%, transparent); }
    .trace[aria-current="true"] { background: color-mix(in srgb, Highlight 22%, transparent); }
    .trace-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .trace-size { display: block; margin-top: 3px; opacity: .65; font-size: 11px; }
    #sidebar-resizer { position: absolute; z-index: 1; top: 0; right: 0; width: 5px; height: 100%; cursor: col-resize; touch-action: none; }
    #sidebar-resizer:hover, #sidebar-resizer:focus-visible { background: Highlight; }
    body[data-resizing] { cursor: col-resize; user-select: none; }
    #viewer-shell { position: relative; width: 100%; height: 100%; min-width: 0; }
    #viewer { display: block; width: 100%; max-width: 100%; height: 100%; min-width: 0; border: 0; }
    #status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; padding: 24px; background: Canvas; color: CanvasText; text-align: center; }
    #status[hidden] { display: none; }
  </style>
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <h1>${escapeHtml(options.title)}</h1>
      <input id="filter" type="search" placeholder="Filter traces" aria-label="Filter traces">
      <div id="traces"></div>
      <div id="sidebar-resizer" role="separator" aria-label="Resize trace sidebar" aria-orientation="vertical" aria-valuemin="180" tabindex="0"></div>
    </aside>
    <main id="viewer-shell">
      <div id="status">Loading Playwright Trace Viewer…</div>
      <iframe id="viewer" title="Playwright Trace Viewer"></iframe>
    </main>
  </div>
  <script>
    const traces = ${serializedTraces}
    const packTitle = ${serializedTitle}
    const viewerUrl = ${serializedViewerUrl}
    const viewerOrigin = ${serializedViewerOrigin}
    const viewer = document.querySelector('#viewer')
    const status = document.querySelector('#status')
    const sidebar = document.querySelector('#sidebar')
    const sidebarResizer = document.querySelector('#sidebar-resizer')
    const traceList = document.querySelector('#traces')
    const filter = document.querySelector('#filter')
    const selectedTraceId = new URL(window.location.href).searchParams.get('trace')
    let selectedTrace = traces.find(trace => trace.id === selectedTraceId)
    let viewerReady = false

    function formatBytes(bytes) {
      if (bytes < 1024)
        return bytes + ' B'
      if (bytes < 1024 * 1024)
        return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    }

    function decodeTrace(base64) {
      const chunks = []
      const chunkSize = 1024 * 1024
      for (let offset = 0; offset < base64.length; offset += chunkSize) {
        const binary = atob(base64.slice(offset, offset + chunkSize))
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index++)
          bytes[index] = binary.charCodeAt(index)
        chunks.push(bytes)
      }
      return new Blob(chunks, { type: 'application/zip' })
    }

    function loadSelectedTrace() {
      if (!viewerReady || !selectedTrace)
        return
      status.textContent = 'Opening ' + selectedTrace.title + '…'
      status.hidden = false
      const trace = decodeTrace(selectedTrace.base64)
      viewer.contentWindow.postMessage({ method: 'load', params: { trace } }, viewerOrigin)
      status.hidden = true
      document.title = selectedTrace.title + ' · ' + packTitle
    }

    function showTraceSelection() {
      status.textContent = 'Select a trace from the sidebar.'
      status.hidden = false
    }

    function resizeSidebar(width) {
      const minimumWidth = 180
      const maximumWidth = Math.max(minimumWidth, window.innerWidth - 480)
      const resolvedWidth = Math.min(maximumWidth, Math.max(minimumWidth, width))
      document.documentElement.style.setProperty('--sidebar-width', resolvedWidth + 'px')
      sidebarResizer.setAttribute('aria-valuemax', String(Math.round(maximumWidth)))
      sidebarResizer.setAttribute('aria-valuenow', String(Math.round(resolvedWidth)))
    }

    function selectTrace(trace) {
      selectedTrace = trace
      const url = new URL(window.location.href)
      url.searchParams.set('trace', trace.id)
      window.history.replaceState({}, '', url)
      for (const button of traceList.children)
        button.setAttribute('aria-current', String(button.dataset.traceId === trace.id))
      loadSelectedTrace()
    }

    function renderTraceList(query = '') {
      const normalizedQuery = query.trim().toLowerCase()
      traceList.replaceChildren()
      for (const trace of traces) {
        if (normalizedQuery && !trace.title.toLowerCase().includes(normalizedQuery))
          continue
        const button = document.createElement('button')
        button.className = 'trace'
        button.dataset.traceId = trace.id
        button.setAttribute('aria-current', String(trace.id === selectedTrace?.id))
        const title = document.createElement('span')
        title.className = 'trace-title'
        title.textContent = trace.title
        title.title = trace.title
        const size = document.createElement('span')
        size.className = 'trace-size'
        size.textContent = formatBytes(trace.size)
        button.append(title, size)
        button.addEventListener('click', () => selectTrace(trace))
        traceList.append(button)
      }
    }

    window.addEventListener('message', event => {
      if (event.origin !== viewerOrigin || event.source !== viewer.contentWindow)
        return
      if (event.data?.method !== 'ready')
        return
      viewerReady = true
      if (selectedTrace)
        loadSelectedTrace()
      else
        showTraceSelection()
    })

    filter?.addEventListener('input', () => renderTraceList(filter.value))
    sidebarResizer.addEventListener('pointerdown', event => {
      document.body.dataset.resizing = ''
      sidebarResizer.setPointerCapture(event.pointerId)
    })
    sidebarResizer.addEventListener('pointermove', event => {
      if (sidebarResizer.hasPointerCapture(event.pointerId))
        resizeSidebar(event.clientX)
    })
    sidebarResizer.addEventListener('pointerup', event => {
      delete document.body.dataset.resizing
      sidebarResizer.releasePointerCapture(event.pointerId)
    })
    sidebarResizer.addEventListener('pointercancel', () => {
      delete document.body.dataset.resizing
    })
    sidebarResizer.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
        return
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      resizeSidebar(sidebar.getBoundingClientRect().width + direction * 16)
    })
    window.addEventListener('resize', () => resizeSidebar(sidebar.getBoundingClientRect().width))
    renderTraceList()
    resizeSidebar(sidebar.getBoundingClientRect().width)
    viewer.src = viewerUrl

    setTimeout(() => {
      if (!viewerReady)
        status.textContent = 'The Playwright Trace Viewer could not be loaded. Check your network connection.'
    }, 15000)
  </script>
</body>
</html>
`;
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
