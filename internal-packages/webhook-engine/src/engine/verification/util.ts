import { createHmac, timingSafeEqual as nodeTimingSafeEqual, createHash } from "node:crypto";

// Constant-time compare. NEVER ===. Both sides first hashed to 32-byte sha256 so
// timingSafeEqual gets equal-length buffers (it throws on length mismatch).
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return nodeTimingSafeEqual(ha, hb);
}

export function hmacDigest(
  algorithm: "sha256" | "sha1",
  secret: string | Buffer,
  signingBytes: Uint8Array,
  encoding: "hex" | "base64"
): string {
  return createHmac(algorithm, secret).update(signingBytes).digest(encoding);
}

// The HMAC key bytes from the stored secret. Most providers use the secret verbatim (utf8);
// Svix-family secrets are `whsec_<base64>` → strip the prefix then base64-decode to raw bytes.
export function deriveHmacKey(
  secret: string,
  transform?: { encoding?: "utf8" | "base64"; stripPrefix?: string }
): Buffer {
  let s = secret;
  if (transform?.stripPrefix && s.startsWith(transform.stripPrefix)) {
    s = s.slice(transform.stripPrefix.length);
  }
  return Buffer.from(s, transform?.encoding === "base64" ? "base64" : "utf8");
}

/**
 * The first non-empty value among a header source's `name` and its `fallback` headers, read from a
 * lower-cased header map.
 */
export function readHeader(
  headersLc: Record<string, string>,
  source: { name: string; fallback?: string[] }
): string | undefined {
  for (const name of [source.name, ...(source.fallback ?? [])]) {
    const value = headersLc[name.toLowerCase()];
    if (value) return value;
  }
  return undefined;
}

type TimestampShape = {
  unit?: "seconds" | "milliseconds";
  format?: "unix" | "iso8601" | "http-date";
};

/** Epoch milliseconds for a timestamp value written in the config's format, or undefined. */
export function timestampToMs(value: string, cfg: TimestampShape): number | undefined {
  const format = cfg.format ?? "unix";
  if (format === "unix") {
    if (value.trim() === "") return undefined;
    const n = Number(value);
    if (Number.isNaN(n)) return undefined;
    return cfg.unit === "milliseconds" ? n : n * 1000;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * How far `nowMs` is from the instant a timestamp stands for. An HTTP date carries whole seconds, so
 * `T` stands for some instant in `[T, T + 999ms]`; the distance is to that interval, which keeps the
 * full window in both directions. Other formats are exact instants.
 */
export function timestampDistanceMs(ms: number, nowMs: number, cfg: TimestampShape): number {
  if (cfg.format !== "http-date") return Math.abs(nowMs - ms);
  if (nowMs < ms) return ms - nowMs;
  return Math.max(0, nowMs - (ms + 999));
}

/** `nowMs` written the way the config's format expects it, for the signer. */
export function formatTimestamp(nowMs: number, cfg: TimestampShape): string {
  switch (cfg.format ?? "unix") {
    case "iso8601":
      return new Date(nowMs).toISOString();
    case "http-date":
      return new Date(nowMs).toUTCString();
    case "unix":
      return String(cfg.unit === "milliseconds" ? nowMs : Math.floor(nowMs / 1000));
  }
}

export function decodeSignature(value: string, encoding: "hex" | "base64"): Buffer {
  return Buffer.from(value, encoding);
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

// Build the signing bytes for a templated signing string ("{timestamp}.{body}")
// without ever turning the raw body into a string (preserve exact bytes).
export function buildSigningBytes(
  template: string,
  rawBytes: Uint8Array,
  vars: Record<string, string>
): Uint8Array {
  const BODY = "{body}";
  const idx = template.indexOf(BODY);
  const substitute = (s: string) => s.replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? "");
  if (idx === -1) {
    return new TextEncoder().encode(substitute(template));
  }
  const head = new TextEncoder().encode(substitute(template.slice(0, idx)));
  const tail = new TextEncoder().encode(substitute(template.slice(idx + BODY.length)));
  const out = new Uint8Array(head.length + rawBytes.length + tail.length);
  out.set(head, 0);
  out.set(rawBytes, head.length);
  out.set(tail, head.length + rawBytes.length);
  return out;
}
