import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export interface TraceResponse {
  url: string;
  mimeType: string;
}

/** Remove selected response bodies without dropping resources used elsewhere. */
export function filterTrace(
  data: Uint8Array,
  excludeResponseBody: (response: TraceResponse) => boolean,
): Uint8Array {
  const files = unzipSync(data);
  const candidates = new Set<string>();
  const records = new Map<string, unknown[]>();
  let changed = false;

  // Network and action records can share the same content-addressed resources.
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".network") && !name.endsWith(".trace")) continue;
    records.set(
      name,
      strFromU8(bytes)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  }

  // Keep network metadata but detach the selected response bodies.
  for (const [name, events] of records) {
    if (!name.endsWith(".network")) continue;
    let networkChanged = false;
    for (const event of events) {
      const snapshot = (event as NetworkEvent).snapshot;
      const content = snapshot?.response?.content;
      if (!content || !snapshot?.request?.url) continue;
      if (!excludeResponseBody({ url: snapshot.request.url, mimeType: content.mimeType ?? "" }))
        continue;
      if (typeof content._sha1 === "string") {
        candidates.add(`resources/${content._sha1}`);
        delete content._sha1;
        networkChanged = true;
      }
      if (typeof content._file === "string" && content._file.startsWith("resources/")) {
        candidates.add(content._file);
        delete content._file;
        networkChanged = true;
      }
      if (content.text !== undefined) {
        delete content.text;
        delete content.encoding;
        networkChanged = true;
      }
    }
    if (networkChanged) {
      files[name] = strToU8(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      changed = true;
    }
  }
  if (!changed) return data;

  // A body may still be needed by another response, a snapshot, or an attachment.
  for (const events of records.values()) {
    retainReferences(events, candidates);
  }
  for (const name of candidates) delete files[name];
  return zipSync(files);
}

interface NetworkEvent {
  snapshot?: {
    request?: { url?: string };
    response?: {
      content?: {
        mimeType?: string;
        _sha1?: string;
        _file?: string;
        text?: string;
        encoding?: string;
      };
    };
  };
}

function retainReferences(value: unknown, candidates: Set<string>): void {
  if (typeof value === "string") {
    candidates.delete(`resources/${value}`);
    candidates.delete(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) retainReferences(entry, candidates);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) retainReferences(entry, candidates);
  }
}
