import superjson from "superjson";

export type SourcePacket = {
  data: string | null | undefined;
  dataType: string | null | undefined;
};

export type ParsedSource =
  | { state: "empty" }
  | { state: "offloaded" }
  | { state: "parsed"; value: unknown };

/**
 * Parse a raw payload/metadata/output packet on the client, respecting its
 * content type. Never fetches: an offloaded (`application/store`) packet returns
 * the `offloaded` state rather than its object-store path. A parse failure falls
 * back to the raw string so a malformed value degrades to text, not a throw.
 */
export function parseSource(packet: SourcePacket): ParsedSource {
  const { data, dataType } = packet;
  if (data === null || data === undefined || data === "") {
    return { state: "empty" };
  }

  const type = dataType ?? "application/json";
  if (type === "application/store") {
    return { state: "offloaded" };
  }

  try {
    switch (type) {
      case "application/json":
        return { state: "parsed", value: JSON.parse(data) };
      case "application/super+json":
        return { state: "parsed", value: superjson.parse(data) };
      default:
        return { state: "parsed", value: data };
    }
  } catch {
    return { state: "parsed", value: data };
  }
}

export type SmartCellValue =
  | { state: "empty" }
  | { state: "offloaded" }
  | { state: "value"; value: unknown };

export function extractSmartValue(parsed: ParsedSource, path: string): SmartCellValue {
  if (parsed.state === "empty") return { state: "empty" };
  if (parsed.state === "offloaded") return { state: "offloaded" };

  const value = getAtPath(parsed.value, path);
  if (value === undefined) return { state: "empty" };
  return { state: "value", value };
}

const PATH_TOKEN_RE = /\.([^.[\]]+)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]/g;

/**
 * Read a value out of a parsed object with dot/bracket notation. Accepts a
 * leading `$`, dotted keys, and numeric or quoted bracket indices, e.g.
 * `$.failed`, `suites[0].name`, `$['a.b'].c`. Returns undefined when any
 * segment is missing.
 */
export function getAtPath(root: unknown, path: string): unknown {
  let normalized = path.trim();
  if (normalized.startsWith("$")) normalized = normalized.slice(1);
  if (normalized.length === 0) return root;
  if (!normalized.startsWith(".") && !normalized.startsWith("[")) {
    normalized = `.${normalized}`;
  }

  const tokens: (string | number)[] = [];
  let lastIndex = 0;
  PATH_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_TOKEN_RE.exec(normalized)) !== null) {
    if (match.index !== lastIndex) return undefined;
    lastIndex = PATH_TOKEN_RE.lastIndex;

    if (match[1] !== undefined) tokens.push(match[1]);
    else if (match[2] !== undefined) tokens.push(Number(match[2]));
    else if (match[3] !== undefined) tokens.push(match[3]);
    else if (match[4] !== undefined) tokens.push(match[4]);
  }
  if (lastIndex !== normalized.length) return undefined;

  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[token];
  }
  return current;
}

/** Default column label from a path: its last segment, or the raw path. */
export function labelFromPath(path: string): string {
  let normalized = path.trim();
  if (normalized.startsWith("$")) normalized = normalized.slice(1);
  const segments = normalized.match(/[^.[\]'"]+/g);
  return segments && segments.length > 0 ? segments[segments.length - 1] : path;
}
