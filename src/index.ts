import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, relative, resolve } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";

import { unzipSync } from "fflate";

import { filterTrace, type TraceResponse } from "./filter-trace.js";

export type { TraceResponse } from "./filter-trace.js";

export interface TraceEntry {
  data?: Uint8Array;
  path?: string;
  title?: string;
  /** Structured reporter metadata enables project/file/test navigation. */
  test?: {
    id: string;
    project: string;
    file: string;
    titlePath: string[];
    order: number;
    retry: number;
  };
}

export interface PackOptions {
  outputFile: string;
  excludeResponseBody?: (response: TraceResponse) => boolean;
  title?: string;
  viewerUrl?: string;
}

interface EmbeddedTrace {
  test?: TraceEntry["test"];
  /** Each zip entry's name and its index into the packed files */
  entries: [string, number][];
  id: string;
  title: string;
}

interface PackedFiles {
  /** Offset and length of each file in the decompressed blob */
  files: [number, number][];
  base64: string;
}

export async function packTraces(entries: TraceEntry[], options: PackOptions): Promise<void> {
  if (!entries.length) throw new Error("At least one trace is required");

  const blob = createFileBlob();
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
        test: entry.test,
        entries: Object.entries(unzipSync(data)).map(([name, bytes]) => [name, blob.add(bytes)]),
        id: `trace-${index}`,
        title: entry.title || defaultTitle,
      };
    }),
  );

  const html = await renderTracePack(traces, blob.finish(), {
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

/**
 * Collects every trace's files into one buffer, storing identical files once.
 * Traces from one test run share most of their resources, such as the app's
 * scripts and stylesheets, and their DOM snapshots repeat across tests. zstd
 * with a window as large as the buffer finds those repeats, which deflate's
 * 32 KB window inside each trace zip cannot.
 */
function createFileBlob() {
  const indexByHash = new Map<string, number>();
  const chunks: Uint8Array[] = [];
  const files: [number, number][] = [];
  let offset = 0;
  return {
    add(bytes: Uint8Array): number {
      const hash = createHash("sha1").update(bytes).digest("hex");
      let index = indexByHash.get(hash);
      if (index === undefined) {
        index = files.length;
        indexByHash.set(hash, index);
        files.push([offset, bytes.length]);
        chunks.push(bytes);
        offset += bytes.length;
      }
      return index;
    },
    finish(): PackedFiles {
      const compressed = zstdCompressSync(Buffer.concat(chunks), {
        params: {
          [constants.ZSTD_c_compressionLevel]: 19,
          [constants.ZSTD_c_windowLog]: Math.min(31, Math.max(10, Math.ceil(Math.log2(offset)))),
        },
      });
      return { files, base64: compressed.toString("base64") };
    },
  };
}

function isTraceFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "trace.zip" || name.endsWith(".trace.zip");
}

async function renderTracePack(
  traces: EmbeddedTrace[],
  packed: PackedFiles,
  options: { title: string; viewerUrl: string },
): Promise<string> {
  const viewerUrl = new URL(options.viewerUrl);
  if (
    viewerUrl.protocol !== "https:" &&
    !(viewerUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(viewerUrl.hostname))
  )
    throw new Error("Viewer URL must use HTTPS or local HTTP");

  // Browsers' DecompressionStream has no zstd, so the page inlines a small decoder
  const require = createRequire(import.meta.url);
  const zstdDecoder = await fs.readFile(
    resolve(dirname(require.resolve("fzstd")), "../umd/index.js"),
    "utf8",
  );
  const serializedTraces = serializeForInlineScript(traces);
  const serializedFiles = serializeForInlineScript(packed.files);
  const serializedBlob = serializeForInlineScript(packed.base64);
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
    .group > summary { display: flex; align-items: center; gap: 5px; padding: 8px 4px; cursor: pointer; list-style: none; font-size: 12px; }
    .group > summary::before { content: '▸'; flex: none; width: 10px; }
    .group[open] > summary::before { content: '▾'; }
    .group-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .group-count { margin-left: auto; opacity: .6; flex: none; }
    .group-children { padding-left: 12px; }
    .trace:focus-visible, summary:focus-visible { outline: 2px solid Highlight; outline-offset: -2px; }
    #filter { margin: 0 12px 10px; padding: 7px 9px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 5px; background: Canvas; color: CanvasText; }
    #traces { min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 0 8px 12px; }
    .trace { width: 100%; padding: 9px; border: 0; border-radius: 5px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
    .trace:hover { background: color-mix(in srgb, CanvasText 8%, transparent); }
    .trace[aria-current="true"] { background: color-mix(in srgb, Highlight 22%, transparent); }
    .trace-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  <script>${zstdDecoder}</script>
  <script>
    const traces = ${serializedTraces}
    const packedFiles = ${serializedFiles}
    const packedBlob = ${serializedBlob}
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
    const expandedGroups = new Map()


    let filesPromise

    // Decompress all files once, on the first trace opened
    function loadFiles() {
      filesPromise ??= (async () => {
        const buffer = fzstd.decompress(await decodeBase64(packedBlob))
        return packedFiles.map(([offset, length]) => buffer.subarray(offset, offset + length))
      })()
      return filesPromise
    }

    function decodeBase64(base64) {
      const chunks = []
      const chunkSize = 1024 * 1024
      for (let offset = 0; offset < base64.length; offset += chunkSize) {
        const binary = atob(base64.slice(offset, offset + chunkSize))
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index++)
          bytes[index] = binary.charCodeAt(index)
        chunks.push(bytes)
      }
      return new Blob(chunks).bytes()
    }

    // Rebuild the trace zip without compression, which the viewer reads like any other zip
    function createZip(entries) {
      const encoder = new TextEncoder()
      const localParts = []
      const centralParts = []
      let offset = 0
      for (const [name, data] of entries) {
        const nameBytes = encoder.encode(name)
        const crc = crc32(data)
        const local = new DataView(new ArrayBuffer(30))
        local.setUint32(0, 0x04034b50, true)
        local.setUint16(4, 20, true)
        local.setUint32(14, crc, true)
        local.setUint32(18, data.length, true)
        local.setUint32(22, data.length, true)
        local.setUint16(26, nameBytes.length, true)
        const central = new DataView(new ArrayBuffer(46))
        central.setUint32(0, 0x02014b50, true)
        central.setUint16(4, 20, true)
        central.setUint16(6, 20, true)
        central.setUint32(16, crc, true)
        central.setUint32(20, data.length, true)
        central.setUint32(24, data.length, true)
        central.setUint16(28, nameBytes.length, true)
        central.setUint32(42, offset, true)
        localParts.push(local, nameBytes, data)
        centralParts.push(central, nameBytes)
        offset += 30 + nameBytes.length + data.length
      }
      const centralSize = centralParts.reduce((size, part) => size + part.byteLength, 0)
      const end = new DataView(new ArrayBuffer(22))
      end.setUint32(0, 0x06054b50, true)
      end.setUint16(8, entries.length, true)
      end.setUint16(10, entries.length, true)
      end.setUint32(12, centralSize, true)
      end.setUint32(16, offset, true)
      return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' })
    }

    let crcTable
    function crc32(data) {
      crcTable ??= Array.from({ length: 256 }, (_, n) => {
        for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
        return n >>> 0
      })
      let crc = 0xffffffff
      for (let index = 0; index < data.length; index++)
        crc = crcTable[(crc ^ data[index]) & 0xff] ^ (crc >>> 8)
      return (crc ^ 0xffffffff) >>> 0
    }

    async function loadSelectedTrace() {
      if (!viewerReady || !selectedTrace)
        return
      const loading = selectedTrace
      status.textContent = 'Opening ' + loading.title + '…'
      status.hidden = false
      const files = await loadFiles()
      if (loading !== selectedTrace)
        return
      const trace = createZip(loading.entries.map(([name, index]) => [name, files[index]]))
      viewer.contentWindow.postMessage({ method: 'load', params: { trace } }, viewerOrigin)
      status.hidden = true
      document.title = loading.title + ' · ' + packTitle
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
      for (const button of traceList.querySelectorAll('.trace'))
        button.setAttribute('aria-current', String(button.dataset.traceId === trace.id))
      revealSelectedTrace()
      loadSelectedTrace()
    }

    function revealSelectedTrace() {
      const button = [...traceList.querySelectorAll('.trace')].find(button => button.dataset.traceId === selectedTrace?.id)
      if (!button) return
      for (let parent = button.parentElement; parent !== traceList; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') {
          parent.open = true
          expandedGroups.set(parent.dataset.groupKey, true)
        }
      }
      button.scrollIntoView({ block: 'nearest' })
    }

    function renderTraceList(query = '') {
      const normalizedQuery = query.trim().toLowerCase()
      traceList.replaceChildren()
      const matches = traces.filter(trace => {
        const path = trace.test ? [trace.test.project, trace.test.file, ...trace.test.titlePath].join(' ') : ''
        return (trace.title + ' ' + path).toLowerCase().includes(normalizedQuery)
      })
      const grouped = new Map()
      for (const trace of matches.filter(trace => trace.test).sort((a, b) => a.test.order - b.test.order || a.test.retry - b.test.retry)) {
        const meta = trace.test
        if (!grouped.has(meta.project)) grouped.set(meta.project, new Map())
        const files = grouped.get(meta.project)
        if (!files.has(meta.file)) files.set(meta.file, new Map())
        const tests = files.get(meta.file)
        if (!tests.has(meta.id)) tests.set(meta.id, [])
        tests.get(meta.id).push(trace)
      }
      for (const [project, files] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
        const projectTraces = [...files.values()].flatMap(tests => [...tests.values()].flat())
        const projectParent = appendGroup(traceList, ['project', project], project || 'Unnamed project', projectTraces)
        for (const [file, tests] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
          const fileTraces = [...tests.values()].flat()
          const fileParent = appendGroup(projectParent, ['file', project, file], file, fileTraces)
          for (const [id, attempts] of tests) {
            const label = attempts[0].test.titlePath.join(' › ')
            if (attempts.length === 1) {
              const trace = attempts[0]
              appendTrace(fileParent, trace, label + (trace.test.retry ? ' · retry ' + trace.test.retry : ''))
            } else {
              const testParent = appendGroup(fileParent, ['test', project, file, id], label, attempts)
              for (const trace of attempts)
                appendTrace(testParent, trace, trace.test.retry ? 'Retry ' + trace.test.retry : 'Initial attempt')
            }
          }
        }
      }
      for (const trace of matches.filter(trace => !trace.test))
        appendTrace(traceList, trace, trace.title)
      if (!matches.length) traceList.textContent = 'No matching traces.'

      function appendGroup(parent, path, label, entries) {
        const key = JSON.stringify(path)
        if (!expandedGroups.has(key))
          expandedGroups.set(key, true)
        const details = document.createElement('details')
        details.className = 'group'
        details.dataset.groupKey = key
        details.dataset.groupType = path[0]
        details.open = normalizedQuery ? true : expandedGroups.get(key)
        const summary = document.createElement('summary')
        const title = document.createElement('span')
        title.className = 'group-label'
        title.textContent = label
        title.title = label
        const count = document.createElement('span')
        count.className = 'group-count'
        const total = path[0] === 'test' ? entries.length : new Set(entries.map(trace => trace.test.id)).size
        count.textContent = String(total)
        count.setAttribute('aria-label', total + (path[0] === 'test' ? ' traces' : ' tests'))
        summary.append(title, count)
        const children = document.createElement('div')
        children.className = 'group-children'
        summary.addEventListener('click', event => {
          event.preventDefault()
          details.open = !details.open
          if (!normalizedQuery) expandedGroups.set(key, details.open)
        })
        details.append(summary, children)
        parent.append(details)
        return children
      }
    }

    function appendTrace(parent, trace, label) {
      const button = document.createElement('button')
      button.className = 'trace'
      button.dataset.traceId = trace.id
      button.setAttribute('aria-current', String(trace.id === selectedTrace?.id))
      const title = document.createElement('span')
      title.className = 'trace-title'
      title.textContent = label
      title.title = trace.title
      button.append(title)
      button.addEventListener('click', () => selectTrace(trace))
      parent.append(button)
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
    revealSelectedTrace()
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
