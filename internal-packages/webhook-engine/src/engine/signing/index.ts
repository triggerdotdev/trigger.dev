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

function signHmac(cfg: WebhookHmacConfig, args: SignArgs): SignResult {
  const headers: Record<string, string> = { ...(args.headers ?? {}) };
  const headersLc = lowerCaseHeaders(headers);
  const now = args.nowMs ?? Date.now();

  let timestampValue = "";
  if (cfg.timestamp) {
    const src = cfg.timestamp.source;
    if (src.from === "header" || src.from === "signatureField") {
      timestampValue =
        cfg.timestamp.unit === "milliseconds" ? String(now) : String(Math.floor(now / 1000));
      if (src.from === "header") {
        headers[src.name] = timestampValue;
        headersLc[src.name.toLowerCase()] = timestampValue;
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
