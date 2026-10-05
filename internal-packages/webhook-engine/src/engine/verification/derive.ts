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
            parseEventBody(args.rawBytes, {
              formPayloadField: args.formPayloadField,
              headers: args.headers,
            }).parsedEvent as Record<string, unknown> | undefined,
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
 * JSON-parses that field's value (Slack interactivity posts `payload=<json>`). Otherwise a body sent
 * with a form `content-type` (lower-cased `headers`) becomes the decoded form itself, with a
 * repeated key collected into an array (Slack slash commands, Twilio). The signature was already
 * checked over the raw bytes, so this only affects the parsed event, never verification.
 */
export function parseEventBody(
  rawBytes: Uint8Array,
  opts?: { formPayloadField?: string; headers?: Record<string, string> }
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
  if (isFormEncoded(opts?.headers)) return { parsedEvent: decodeForm(text) };
  return { error: "verified body is not valid JSON" };
}

/** Whether `headers` declare an `application/x-www-form-urlencoded` body, matching the name in any case. */
export function isFormEncoded(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-type") continue;
    return value.split(";")[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
  }
  return false;
}

function decodeForm(text: string): Record<string, string | string[]> {
  const fields = new Map<string, string | string[]>();
  for (const [key, value] of new URLSearchParams(text)) {
    const previous = fields.get(key);
    if (previous === undefined) fields.set(key, value);
    else if (Array.isArray(previous)) previous.push(value);
    else fields.set(key, [previous, value]);
  }
  return Object.fromEntries(fields);
}
