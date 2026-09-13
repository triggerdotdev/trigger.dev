import { subtle } from "../imports/uncrypto.js";

/**
 * Test fixtures for {@link standardWebhooks.verify}.
 *
 * The secret is 32 raw bytes encoded as base64 to match the format
 * Standard Webhooks providers hand out. `sign()` mirrors the on-the-wire
 * format exactly: `v1,<base64-hmac-of-id.timestamp.body>`.
 */

export const TEST_SECRET_BYTES = Buffer.from(
  "d2hzZWNfdGVzdF9zdXBlcl9zZWNyZXRfa2V5X2Zvcl9zdGFuZGFyZF93ZWJob29rcw==",
  "base64"
);

export const TEST_SECRET_BASE64 = TEST_SECRET_BYTES.toString("base64");

export const TEST_BODY = JSON.stringify({
  type: "order.created",
  data: { id: "ord_123", amount: 4200 },
});

export const TEST_ID = "msg_2YuG3w7H1n7R8zXK9mN4pQ";

/**
 * Computes the `v1,<base64-hmac>` portion of the signature header for the
 * given id / timestamp / body / secret bytes. Mirrors the algorithm in
 * `verifyStandardWebhooks`. The timestamp is stringified exactly as
 * received so that a request with a non-numeric timestamp can still be
 * signed for negative tests.
 */
export async function signV1(
  secretBytes: Uint8Array,
  id: string,
  timestamp: number | string,
  body: string
): Promise<string> {
  const signedContent = `${id}.${timestamp}.${body}`;
  const key = await subtle.importKey(
    "raw",
    // Wrap in a fresh Uint8Array so the generic is bound to ArrayBuffer
    // rather than ArrayBufferLike; matches what Buffer.from(string, ...)
    // infers and avoids an ArrayBufferLike/ArrayBuffer mismatch.
    new Uint8Array(secretBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await subtle.sign("HMAC", key, Buffer.from(signedContent, "utf-8"));
  return `v1,${Buffer.from(digest).toString("base64")}`;
}

export type BuildRequestOptions = {
  id?: string;
  timestamp?: number | string;
  body?: string;
  signatureHeader?: string;
  /** If true, omit the given header. Useful for negative tests. */
  omit?: "id" | "timestamp" | "signature";
};

export async function buildSignedRequest(opts: BuildRequestOptions = {}): Promise<Request> {
  const id = opts.id ?? TEST_ID;
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const body = opts.body ?? TEST_BODY;
  const signature =
    opts.signatureHeader ?? (await signV1(TEST_SECRET_BYTES, id, Number(timestamp), body));

  const headers = new Headers({ "content-type": "application/json" });
  if (opts.omit !== "id") headers.set("webhook-id", id);
  if (opts.omit !== "timestamp") headers.set("webhook-timestamp", String(timestamp));
  if (opts.omit !== "signature") headers.set("webhook-signature", signature);

  return new Request("https://example.com/webhook", {
    method: "POST",
    headers,
    body,
  });
}

/**
 * Convenience for tests that need to call {@link standardWebhooks.verify}
 * twice on logically-equal inputs — `Request.body` is a single-use stream.
 */
export async function buildSignedRequestPair(
  opts: BuildRequestOptions = {}
): Promise<[Request, Request]> {
  return [await buildSignedRequest(opts), await buildSignedRequest(opts)];
}

/**
 * Static, reviewable happy-path fixture. Captured at test-suite authoring
 * time so the values can be diffed in code review. The timestamp is
 * 1700000000 (2023-11-14), well outside the default 300s tolerance — tests
 * that use this fixture must pass `tolerance: 0` or generate a current
 * timestamp.
 */
export const STATIC_HAPPY_PATH = {
  secretBase64: TEST_SECRET_BASE64,
  id: "msg_static_review_fixture",
  timestamp: 1700000000,
  body: '{"hello":"world"}',
} as const;
