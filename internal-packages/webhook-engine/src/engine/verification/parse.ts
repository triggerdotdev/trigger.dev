import type {
  WebhookSignatureExtraction,
  WebhookSigningString,
  WebhookTimestampConfig,
  WebhookValueSource,
} from "@trigger.dev/core/v3";
import { readPath, tryParseJson } from "./derive.js";
import type { VerifyInput } from "./types.js";
import { buildSigningBytes } from "./util.js";

// The subset of a verifier config shared by every signed scheme (hmac, asymmetric).
export type SignedConfig = {
  signatureHeader: string;
  signature?: WebhookSignatureExtraction;
  timestamp?: WebhookTimestampConfig;
  signingString: WebhookSigningString;
};

export type PreparedVerification =
  | { ok: false; error: string }
  | {
      ok: true;
      signatures: string[]; // candidate signatures; the scheme accepts ANY match
      signingBytes: Uint8Array;
      timestampValue: string;
      signatureValue: string; // first candidate, for the idempotency fallback hash
    };

// Parse one signature header into (a) candidate signature strings and (b) a field map for
// signatureField lookups (e.g. Stripe `t`). See WebhookSignatureExtraction for the shapes.
export function parseSignatureHeader(
  headerValue: string,
  extraction?: WebhookSignatureExtraction
): { signatures: string[]; fields: Map<string, string[]> } {
  const ex = extraction ?? {};
  const rawItems = ex.itemSeparator ? headerValue.split(ex.itemSeparator) : [headerValue];
  const items = ex.trim ? rawItems.map((s) => s.trim()) : rawItems;

  const fields = new Map<string, string[]>();
  const signatures: string[] = [];

  for (const item of items) {
    if (ex.fieldSeparator) {
      const idx = item.indexOf(ex.fieldSeparator);
      if (idx === -1) continue; // malformed element, skip
      const name = item.slice(0, idx);
      const value = item.slice(idx + ex.fieldSeparator.length);
      const arr = fields.get(name) ?? [];
      arr.push(value);
      fields.set(name, arr);
      if (ex.field && name === ex.field) signatures.push(value);
    } else {
      // No field separator → the whole element IS the signature (bare value).
      signatures.push(item);
    }
  }

  return { signatures, fields };
}

type ResolveContext = {
  headers: Record<string, string>;
  fields: Map<string, string[]>;
  rawBytes: Uint8Array;
  url: string;
};

function resolveValueSource(source: WebhookValueSource, ctx: ResolveContext): string | undefined {
  switch (source.from) {
    case "header":
      return ctx.headers[source.name.toLowerCase()];
    case "signatureField":
      return ctx.fields.get(source.field)?.[0];
    case "body": {
      const parsed = tryParseJson(ctx.rawBytes).parsedEvent as Record<string, unknown> | undefined;
      const v = readPath(parsed, source.path);
      return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
    }
    case "url":
      return ctx.url;
    case "constant":
      return source.value;
  }
}

// Shared pre-verification: pull the signature(s) out of the header, validate the timestamp
// (replay window), and build the exact bytes to be signed. The scheme-specific code then only
// computes/compares the signature. No per-provider branching lives here — it's all config.
export function prepareSignedVerification(
  config: SignedConfig,
  input: VerifyInput
): PreparedVerification {
  const rawHeader = input.headers[config.signatureHeader.toLowerCase()];
  if (!rawHeader) return { ok: false, error: "missing signature header" };

  const { signatures, fields } = parseSignatureHeader(rawHeader, config.signature);
  if (signatures.length === 0) return { ok: false, error: "no signature found in header" };

  const ctx: ResolveContext = {
    headers: input.headers,
    fields,
    rawBytes: input.rawBytes,
    url: input.url,
  };

  let timestampValue = "";
  if (config.timestamp) {
    const v = resolveValueSource(config.timestamp.source, ctx);
    if (!v) return { ok: false, error: "missing timestamp" };
    const n = Number(v);
    if (Number.isNaN(n)) return { ok: false, error: "unparseable timestamp" };
    timestampValue = v;
    if (config.timestamp.toleranceSeconds !== undefined) {
      const tsSeconds = config.timestamp.unit === "milliseconds" ? n / 1000 : n;
      const nowS = (input.nowMs ?? Date.now()) / 1000;
      if (Math.abs(nowS - tsSeconds) > config.timestamp.toleranceSeconds) {
        return { ok: false, error: "timestamp outside tolerance" };
      }
    }
  }

  let signingBytes: Uint8Array;
  if (config.signingString === "raw") {
    signingBytes = input.rawBytes;
  } else {
    const vars: Record<string, string> = { timestamp: timestampValue };
    if (config.signingString.vars) {
      for (const [name, source] of Object.entries(config.signingString.vars)) {
        vars[name] = resolveValueSource(source, ctx) ?? "";
      }
    }
    signingBytes = buildSigningBytes(config.signingString.template, input.rawBytes, vars);
  }

  return { ok: true, signatures, signingBytes, timestampValue, signatureValue: signatures[0] };
}
