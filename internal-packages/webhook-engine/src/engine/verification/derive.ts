import { sha256Hex } from "./util.js";

export function deriveIdempotencyKey(args: {
  idempotencyField?: { from: "header" | "body"; name: string }; // Q9
  headers: Record<string, string>;
  rawBytes: Uint8Array;
  timestampValue: string;
  signatureValue: string;
  formPayloadField?: string;
}): string {
  if (args.idempotencyField) {
    const { from, name } = args.idempotencyField;
    const v =
      from === "header"
        ? args.headers[name.toLowerCase()]
        : readPath(
            parseEventBody(args.rawBytes, { formPayloadField: args.formPayloadField })
              .parsedEvent as Record<string, unknown> | undefined,
            name
          );
    if (typeof v === "string" && v.length > 0) return v;
  }
  const composite = `${sha256Hex(args.rawBytes)}\n${args.timestampValue}\n${args.signatureValue}`;
  return sha256Hex(composite);
}

export function readPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<any>((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/**
 * Parse the verified body into the routed event. Tries JSON first. When that fails and a
 * `formPayloadField` is configured, decodes the body as `application/x-www-form-urlencoded` and
 * JSON-parses that field's value (Slack interactivity posts `payload=<json>`). The signature was
 * already checked over the raw bytes, so this only affects the parsed event, never verification.
 */
export function parseEventBody(
  rawBytes: Uint8Array,
  opts?: { formPayloadField?: string }
): { parsedEvent?: unknown; error?: string } {
  const text = new TextDecoder().decode(rawBytes);
  try {
    return { parsedEvent: JSON.parse(text) };
  } catch {
    void 0;
  }
  if (opts?.formPayloadField) {
    try {
      const raw = new URLSearchParams(text).get(opts.formPayloadField);
      if (raw != null) return { parsedEvent: JSON.parse(raw) };
    } catch {
      void 0;
    }
  }
  return { error: "verified body is not valid JSON" };
}

export function tryParseJson(rawBytes: Uint8Array): { parsedEvent?: unknown; error?: string } {
  return parseEventBody(rawBytes);
}
