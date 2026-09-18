import type {
  WebhookHmacConfig,
  WebhookSharedSecretConfig,
  WebhookUrlSecretConfig,
  WebhookValueSource,
  WebhookVerifierConfig,
} from "@trigger.dev/core/v3";
import { randomUUID } from "node:crypto";
import { readPath, tryParseJson } from "../verification/derive.js";
import { buildSigningBytes, deriveHmacKey, hmacDigest } from "../verification/util.js";

export type SignResult =
  | { ok: true; headers: Record<string, string>; url: string; body: Uint8Array }
  | { ok: false; notSignable: boolean; error: string };

export type SignArgs = {
  config: WebhookVerifierConfig;
  secret: string;
  rawBody: Uint8Array;
  url: string;
  headers?: Record<string, string>;
  nowMs?: number;
  /**
   * For a config whose replay window reads the timestamp from the body: rewrite that body field to
   * `nowMs` before signing, so a recorded sample or an older payload verifies on the current clock.
   * The console send path sets this; the public ingress never signs.
   */
  refreshBodyTimestamp?: boolean;
};

/**
 * Produce a request the engine verifier accepts under the same config + secret. The inverse of
 * `verification/`: it owns both the signed value and its placement, so re-parsing the request it
 * builds yields byte-identical signing bytes and a matching signature. Asymmetric and url-secret
 * `path` placement return `{ ok: false, notSignable: true }` (simulate-only downstream).
 */
export function signWithVerifierConfig(args: SignArgs): SignResult {
  const { config } = args;
  switch (config.scheme) {
    case "hmac":
      return signHmac(config, args);
    case "shared-secret":
      return signSharedSecret(config, args);
    case "url-secret":
      return signUrlSecret(config, args);
    case "asymmetric":
      return {
        ok: false,
        notSignable: true,
        error:
          "asymmetric signatures cannot be produced (only the public key is held); use unsigned/tampered or simulate mode",
      };
  }
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function readStringSource(
  source: WebhookValueSource,
  args: SignArgs,
  headersLc: Record<string, string>
): string | undefined {
  switch (source.from) {
    case "header":
      return headersLc[source.name.toLowerCase()];
    case "url":
      return args.url;
    case "constant":
      return source.value;
    case "body": {
      const parsed = tryParseJson(args.rawBody).parsedEvent as Record<string, unknown> | undefined;
      const v = readPath(parsed, source.path);
      return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
    }
    case "signatureField":
      return undefined;
  }
}

function signHmac(cfg: WebhookHmacConfig, signArgs: SignArgs): SignResult {
  const headers: Record<string, string> = { ...(signArgs.headers ?? {}) };
  const headersLc = lowerCaseHeaders(headers);
  const now = signArgs.nowMs ?? Date.now();
  const nowInUnit = cfg.timestamp?.unit === "milliseconds" ? now : Math.floor(now / 1000);

  let args = signArgs;
  let timestampValue = "";
  if (cfg.timestamp) {
    const src = cfg.timestamp.source;
    if (src.from === "header" || src.from === "signatureField") {
      timestampValue = String(nowInUnit);
      if (src.from === "header") {
        headers[src.name] = timestampValue;
        headersLc[src.name.toLowerCase()] = timestampValue;
      }
    } else if (src.from === "body" && signArgs.refreshBodyTimestamp) {
      const refreshed = withBodyTimestamp(signArgs.rawBody, src.path, nowInUnit);
      if (refreshed) {
        args = { ...signArgs, rawBody: refreshed };
        timestampValue = String(nowInUnit);
      } else {
        timestampValue = readStringSource(src, args, headersLc) ?? "";
      }
    } else {
      timestampValue = readStringSource(src, args, headersLc) ?? "";
    }
  }

  let signingBytes: Uint8Array;
  if (cfg.signingString === "raw") {
    signingBytes = args.rawBody;
  } else {
    const vars: Record<string, string> = { timestamp: timestampValue };
    for (const [name, source] of Object.entries(cfg.signingString.vars ?? {})) {
      let v: string | undefined;
      if (source.from === "header") {
        v = headersLc[source.name.toLowerCase()] ?? randomUUID();
        headers[source.name] = v;
        headersLc[source.name.toLowerCase()] = v;
      } else {
        v = readStringSource(source, args, headersLc);
      }
      vars[name] = v ?? "";
    }
    signingBytes = buildSigningBytes(cfg.signingString.template, args.rawBody, vars);
  }

  const digest = hmacDigest(
    cfg.algorithm,
    deriveHmacKey(args.secret, cfg.secret),
    signingBytes,
    cfg.encoding
  );
  headers[cfg.signatureHeader] = buildSignatureHeader(cfg, digest, timestampValue);
  return { ok: true, headers, url: args.url, body: args.rawBody };
}

/**
 * The body with the JSON field at `path` set to `value`, re-serialized; undefined when the body is
 * not a JSON object or the existing field is not a string/number (the caller signs it as it is).
 */
function withBodyTimestamp(
  rawBody: Uint8Array,
  path: string,
  value: number
): Uint8Array | undefined {
  const parsed = tryParseJson(rawBody).parsedEvent;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const keys = path.split(".");
  if (keys.some((key) => key === "" || UNSAFE_PATH_KEYS.has(key))) return undefined;
  let target: Record<string, unknown> = parsed as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    if (Object.getOwnPropertyDescriptor(target, key) === undefined) return undefined;
    const next = target[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) return undefined;
    target = next as Record<string, unknown>;
  }
  const key = keys[keys.length - 1]!;
  const existing = Object.getOwnPropertyDescriptor(target, key)?.value;
  // Preserve the provider's payload type; do not invent missing timestamp fields.
  if (typeof existing !== "string" && typeof existing !== "number") return undefined;
  target[key] = typeof existing === "string" ? String(value) : value;
  return new TextEncoder().encode(JSON.stringify(parsed));
}

/**
 * Path segments that would walk or write the prototype chain of the parsed body. The config path is
 * tenant-supplied and the body is parsed into a plain object in the shared webapp process, so a write
 * through one of these would reach Object.prototype.
 */
const UNSAFE_PATH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Inverse of `parseSignatureHeader`: assemble the element(s) the verifier will split back out. */
function buildSignatureHeader(
  cfg: WebhookHmacConfig,
  digest: string,
  timestampValue: string
): string {
  const ex = cfg.signature;
  const elements: string[] = [];
  if (cfg.timestamp?.source.from === "signatureField" && ex?.fieldSeparator) {
    elements.push(`${cfg.timestamp.source.field}${ex.fieldSeparator}${timestampValue}`);
  }
  if (ex?.field && ex.fieldSeparator) {
    elements.push(`${ex.field}${ex.fieldSeparator}${digest}`);
  } else {
    elements.push(digest);
  }
  return elements.join(ex?.itemSeparator ?? "");
}

function signSharedSecret(cfg: WebhookSharedSecretConfig, args: SignArgs): SignResult {
  const headers: Record<string, string> = { ...(args.headers ?? {}) };
  let body = args.rawBody;
  switch (cfg.placement) {
    case "header":
      headers[cfg.fieldName ?? ""] = args.secret;
      break;
    case "bearer":
      headers["authorization"] = `Bearer ${args.secret}`;
      break;
    case "basic":
      headers["authorization"] = `Basic ${Buffer.from(`:${args.secret}`).toString("base64")}`;
      break;
    case "body": {
      const parsed = tryParseJson(args.rawBody).parsedEvent;
      if (parsed == null || typeof parsed !== "object") {
        return {
          ok: false,
          notSignable: false,
          error: "body placement requires a JSON object body",
        };
      }
      const next = { ...(parsed as Record<string, unknown>), [cfg.fieldName ?? ""]: args.secret };
      body = new TextEncoder().encode(JSON.stringify(next));
      break;
    }
  }
  return { ok: true, headers, url: args.url, body };
}

function signUrlSecret(cfg: WebhookUrlSecretConfig, args: SignArgs): SignResult {
  if (cfg.placement === "path") {
    return {
      ok: false,
      notSignable: true,
      error:
        "url-secret path placement cannot be represented on the fixed ingress URL; use simulate mode",
    };
  }
  const url = new URL(args.url);
  url.searchParams.set(cfg.paramName, args.secret);
  return {
    ok: true,
    headers: { ...(args.headers ?? {}) },
    url: url.toString(),
    body: args.rawBody,
  };
}
