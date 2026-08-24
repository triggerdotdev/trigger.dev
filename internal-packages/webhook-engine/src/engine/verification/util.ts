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
