/**
 * `trigger://` URIs — the single, stable way the dashboard agent points at a
 * resource. Every evidence item, navigate intent, and stored reference uses one,
 * so links survive renames, page-route changes, and transcript replay.
 *
 * The v1 grammar is FROZEN. Adding a resource kind is additive (a new variant);
 * changing an existing one is a breaking change that invalidates stored
 * transcripts, so don't.
 *
 * ```
 * trigger://{proj}/{env}/run/{id}
 * trigger://{proj}/{env}/run/{id}/span/{spanId}
 * trigger://{proj}/{env}/error/{fingerprint}
 * trigger://{proj}/{env}/queue/{name}
 * trigger://{proj}/{env}/deployment/{version}
 * trigger://{proj}/{env}/report/{key}
 * trigger://{proj}/{env}/source/{sha}/{path}?line={n}
 * trigger://{proj}/{env}/investigation/{id}
 * ```
 *
 * `{proj}` is the project's external ref (`proj_…`) — rename-stable and the same
 * value the public API takes as `projectRef`.
 *
 * `{env}` is the RuntimeEnvironment **id**, not its name or slug. It is the only
 * environment identifier that is globally unique, stable across renames, covers
 * preview-branch environments, and carries no secret. Environment names and
 * slugs are display-only and MUST NOT appear in a URI.
 *
 * Every segment that can carry an arbitrary value (queue names, error
 * fingerprints, deployment versions, report keys) is a percent-encoded path
 * segment. A source `{path}` keeps its `/` separators but percent-encodes each
 * individual segment, so a nested path stays readable while a `/` inside a
 * single filename still round-trips.
 */
import { z } from "zod";

/** A validated `trigger://` URI string. Produce one with {@link formatTriggerUri}. */
export type TriggerUri = string & { readonly __brand: "TriggerUri" };

export type ParsedTriggerUri =
  | { kind: "run"; projectRef: string; environmentId: string; runId: string }
  | { kind: "span"; projectRef: string; environmentId: string; runId: string; spanId: string }
  | { kind: "error"; projectRef: string; environmentId: string; fingerprint: string }
  | { kind: "queue"; projectRef: string; environmentId: string; name: string }
  | { kind: "deployment"; projectRef: string; environmentId: string; version: string }
  | { kind: "report"; projectRef: string; environmentId: string; key: string }
  | {
      kind: "source";
      projectRef: string;
      environmentId: string;
      sha: string;
      /** Repo-relative path, `/`-separated. */
      path: string;
      line?: number;
    }
  | { kind: "investigation"; projectRef: string; environmentId: string; investigationId: string };

/** The resource kinds in the v1 grammar. Doubles as the evidence `kind` enum. */
export const TRIGGER_URI_KINDS = [
  "run",
  "span",
  "error",
  "queue",
  "deployment",
  "report",
  "source",
  "investigation",
] as const;

export type TriggerUriKind = (typeof TRIGGER_URI_KINDS)[number];

export const triggerUriKindSchema = z.enum(TRIGGER_URI_KINDS);

export type TriggerUriParseResult =
  | { success: true; data: ParsedTriggerUri }
  | { success: false; error: string };

export class TriggerUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerUriError";
  }
}

const SCHEME = "trigger://";

/**
 * Non-throwing parse, zod's `safeParse` shape. {@link parseTriggerUri} is the
 * throwing wrapper — use that when a malformed URI is a bug, and this one when
 * it's untrusted input (a model tool call, a stored transcript).
 */
export function safeParseTriggerUri(input: string): TriggerUriParseResult {
  if (typeof input !== "string" || input.length === 0) {
    return fail("expected a non-empty string");
  }

  if (!input.startsWith(SCHEME)) {
    return fail(`expected the ${SCHEME} scheme`);
  }

  const rest = input.slice(SCHEME.length);

  if (rest.includes("#")) {
    return fail("fragments are not part of the grammar");
  }

  const queryStart = rest.indexOf("?");
  const pathPart = queryStart === -1 ? rest : rest.slice(0, queryStart);
  const queryPart = queryStart === -1 ? "" : rest.slice(queryStart + 1);

  const rawSegments = pathPart.split("/");

  if (rawSegments.some((segment) => segment.length === 0)) {
    return fail("empty path segment");
  }

  const segments: string[] = [];

  for (const raw of rawSegments) {
    let decoded: string;

    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return fail(`malformed percent-encoding in segment "${raw}"`);
    }

    if (decoded.length === 0) {
      return fail("empty path segment");
    }

    segments.push(decoded);
  }

  if (segments.length < 4) {
    return fail("expected at least trigger://{proj}/{env}/{kind}/{id}");
  }

  const [projectRef, environmentId, resource, ...tail] = segments as [
    string,
    string,
    string,
    ...string[],
  ];

  if (resource !== "source" && queryPart.length > 0) {
    return fail(`query params are only supported on source URIs, got "?${queryPart}"`);
  }

  switch (resource) {
    case "run": {
      if (tail.length === 1) {
        return ok({ kind: "run", projectRef, environmentId, runId: tail[0]! });
      }

      if (tail.length === 3 && tail[1] === "span") {
        return ok({
          kind: "span",
          projectRef,
          environmentId,
          runId: tail[0]!,
          spanId: tail[2]!,
        });
      }

      return fail("expected run/{id} or run/{id}/span/{spanId}");
    }
    case "error": {
      if (tail.length !== 1) return fail("expected error/{fingerprint}");
      return ok({ kind: "error", projectRef, environmentId, fingerprint: tail[0]! });
    }
    case "queue": {
      if (tail.length !== 1) return fail("expected queue/{name}");
      return ok({ kind: "queue", projectRef, environmentId, name: tail[0]! });
    }
    case "deployment": {
      if (tail.length !== 1) return fail("expected deployment/{version}");
      return ok({ kind: "deployment", projectRef, environmentId, version: tail[0]! });
    }
    case "report": {
      if (tail.length !== 1) return fail("expected report/{key}");
      return ok({ kind: "report", projectRef, environmentId, key: tail[0]! });
    }
    case "investigation": {
      if (tail.length !== 1) return fail("expected investigation/{id}");
      return ok({ kind: "investigation", projectRef, environmentId, investigationId: tail[0]! });
    }
    case "source": {
      if (tail.length < 2) return fail("expected source/{sha}/{path}");

      const line = parseLineParam(queryPart);

      if (!line.success) return fail(line.error);

      return ok({
        kind: "source",
        projectRef,
        environmentId,
        sha: tail[0]!,
        path: tail.slice(1).join("/"),
        ...(line.line === undefined ? {} : { line: line.line }),
      });
    }
    default:
      return fail(`unknown resource kind "${resource}"`);
  }
}

/** Throwing parse. Throws {@link TriggerUriError} on anything malformed. */
export function parseTriggerUri(input: string): ParsedTriggerUri {
  const result = safeParseTriggerUri(input);

  if (!result.success) {
    throw new TriggerUriError(`Invalid trigger:// URI: ${result.error}`);
  }

  return result.data;
}

export function isTriggerUri(input: string): input is TriggerUri {
  return safeParseTriggerUri(input).success;
}

/** Serialize a parsed URI back to its canonical string form. */
export function formatTriggerUri(parsed: ParsedTriggerUri): TriggerUri {
  const prefix = `${SCHEME}${segment(parsed.projectRef, "projectRef")}/${segment(
    parsed.environmentId,
    "environmentId"
  )}`;

  switch (parsed.kind) {
    case "run":
      return `${prefix}/run/${segment(parsed.runId, "runId")}` as TriggerUri;
    case "span":
      return `${prefix}/run/${segment(parsed.runId, "runId")}/span/${segment(
        parsed.spanId,
        "spanId"
      )}` as TriggerUri;
    case "error":
      return `${prefix}/error/${segment(parsed.fingerprint, "fingerprint")}` as TriggerUri;
    case "queue":
      return `${prefix}/queue/${segment(parsed.name, "name")}` as TriggerUri;
    case "deployment":
      return `${prefix}/deployment/${segment(parsed.version, "version")}` as TriggerUri;
    case "report":
      return `${prefix}/report/${segment(parsed.key, "key")}` as TriggerUri;
    case "investigation":
      return `${prefix}/investigation/${segment(
        parsed.investigationId,
        "investigationId"
      )}` as TriggerUri;
    case "source": {
      const path = parsed.path
        .split("/")
        .map((part) => segment(part, "path"))
        .join("/");
      const query =
        parsed.line === undefined ? "" : `?line=${assertLine(parsed.line, "format").toString()}`;

      return `${prefix}/source/${segment(parsed.sha, "sha")}/${path}${query}` as TriggerUri;
    }
    default: {
      const unreachable: never = parsed;
      throw new TriggerUriError(`Unhandled resource kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Zod schema for a `trigger://` URI string. Validates the grammar and brands the
 * output, so schemas holding a `uri` field can't be filled with an arbitrary
 * string or a dashboard URL.
 */
export const triggerUriSchema = z
  .string()
  .superRefine((value, ctx) => {
    const result = safeParseTriggerUri(value);

    if (!result.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
    }
  })
  .transform((value) => value as TriggerUri);

function ok(data: ParsedTriggerUri): TriggerUriParseResult {
  return { success: true, data };
}

function fail(error: string): TriggerUriParseResult {
  return { success: false, error };
}

function segment(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TriggerUriError(`Cannot format a trigger:// URI with an empty ${field}`);
  }

  return encodeURIComponent(value);
}

function assertLine(line: number, context: string): number {
  if (!Number.isInteger(line) || line < 1) {
    throw new TriggerUriError(`line must be a positive integer (${context}), got ${line}`);
  }

  return line;
}

function parseLineParam(
  queryPart: string
): { success: true; line?: number } | { success: false; error: string } {
  if (queryPart.length === 0) return { success: true };

  const params = new URLSearchParams(queryPart);
  let line: number | undefined;

  for (const [key, value] of params) {
    if (key !== "line") {
      return { success: false, error: `unknown query param "${key}"` };
    }

    if (!/^\d+$/.test(value) || Number(value) < 1) {
      return { success: false, error: `line must be a positive integer, got "${value}"` };
    }

    line = Number(value);
  }

  return { success: true, line };
}
