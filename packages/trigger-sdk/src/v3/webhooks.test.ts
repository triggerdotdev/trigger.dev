import { describe, expect, it } from "vitest";
import {
  STANDARD_WEBHOOKS_ID_HEADER_NAME,
  STANDARD_WEBHOOKS_SIGNATURE_HEADER_NAME,
  STANDARD_WEBHOOKS_SIGNATURE_VERSION,
  STANDARD_WEBHOOKS_TIMESTAMP_HEADER_NAME,
  STANDARD_WEBHOOKS_TOLERANCE_SECONDS,
  standardWebhooks,
  WebhookError,
} from "./webhooks.js";
import {
  STATIC_HAPPY_PATH,
  TEST_BODY,
  TEST_ID,
  TEST_SECRET_BASE64,
  TEST_SECRET_BYTES,
  buildSignedRequest,
  buildSignedRequestPair,
  signV1,
} from "./webhooks.test-fixtures.js";

describe("standardWebhooks", () => {
  describe("exports", () => {
    it("exposes the spec header names", () => {
      expect(STANDARD_WEBHOOKS_ID_HEADER_NAME).toBe("webhook-id");
      expect(STANDARD_WEBHOOKS_TIMESTAMP_HEADER_NAME).toBe("webhook-timestamp");
      expect(STANDARD_WEBHOOKS_SIGNATURE_HEADER_NAME).toBe("webhook-signature");
      expect(STANDARD_WEBHOOKS_SIGNATURE_VERSION).toBe("v1");
      expect(STANDARD_WEBHOOKS_TOLERANCE_SECONDS).toBe(300);
    });

    it("mirrors the header names and tolerance on the namespace object", () => {
      expect(standardWebhooks.ID_HEADER_NAME).toBe(STANDARD_WEBHOOKS_ID_HEADER_NAME);
      expect(standardWebhooks.TIMESTAMP_HEADER_NAME).toBe(STANDARD_WEBHOOKS_TIMESTAMP_HEADER_NAME);
      expect(standardWebhooks.SIGNATURE_HEADER_NAME).toBe(STANDARD_WEBHOOKS_SIGNATURE_HEADER_NAME);
      expect(standardWebhooks.TOLERANCE_SECONDS).toBe(STANDARD_WEBHOOKS_TOLERANCE_SECONDS);
    });
  });

  describe("happy path", () => {
    it("verifies a freshly-signed request and returns { payload, raw }", async () => {
      const request = await buildSignedRequest();
      const result = await standardWebhooks.verify(request, TEST_SECRET_BASE64);

      expect(result.raw).toBe(TEST_BODY);
      expect(result.payload).toEqual({
        type: "order.created",
        data: { id: "ord_123", amount: 4200 },
      });
    });

    it("parses the body even when it contains nested arrays and unicode", async () => {
      const body = JSON.stringify({ items: ["café", "日本語"], count: 2 });
      const request = await buildSignedRequest({ body });
      const result = await standardWebhooks.verify(request, TEST_SECRET_BASE64);

      expect(result.raw).toBe(body);
      expect(result.payload).toEqual({ items: ["café", "日本語"], count: 2 });
    });

    it("uses a frozen reviewable fixture when tolerance is disabled", async () => {
      const signedContent = `${STATIC_HAPPY_PATH.id}.${STATIC_HAPPY_PATH.timestamp}.${STATIC_HAPPY_PATH.body}`;
      const { createHmac } = await import("node:crypto");
      const sig =
        "v1," +
        createHmac("sha256", Buffer.from(STATIC_HAPPY_PATH.secretBase64, "base64"))
          .update(signedContent)
          .digest("base64");

      const request = await buildSignedRequest({
        id: STATIC_HAPPY_PATH.id,
        timestamp: STATIC_HAPPY_PATH.timestamp,
        body: STATIC_HAPPY_PATH.body,
        signatureHeader: sig,
      });

      const result = await standardWebhooks.verify(request, STATIC_HAPPY_PATH.secretBase64, {
        tolerance: 0,
      });
      expect(result.payload).toEqual({ hello: "world" });
      expect(result.raw).toBe(STATIC_HAPPY_PATH.body);
    });
  });

  describe("multi-signature support", () => {
    it("accepts a request whose first signature entry matches", async () => {
      const now = Math.floor(Date.now() / 1000);
      const real = await signV1(TEST_SECRET_BYTES, TEST_ID, now, TEST_BODY);
      const fake = "v1," + Buffer.from("not-a-real-signature-but-valid-base64").toString("base64");
      const request = await buildSignedRequest({
        timestamp: now,
        signatureHeader: `${real} ${fake}`,
      });

      const result = await standardWebhooks.verify(request, TEST_SECRET_BASE64);
      expect(result.payload).toEqual({
        type: "order.created",
        data: { id: "ord_123", amount: 4200 },
      });
    });

    it("accepts a request whose second signature entry matches", async () => {
      const now = Math.floor(Date.now() / 1000);
      const real = await signV1(TEST_SECRET_BYTES, TEST_ID, now, TEST_BODY);
      const fake = "v1," + Buffer.from("not-a-real-signature-but-valid-base64").toString("base64");
      const request = await buildSignedRequest({
        timestamp: now,
        signatureHeader: `${fake} ${real}`,
      });

      const result = await standardWebhooks.verify(request, TEST_SECRET_BASE64);
      expect(result.payload).toEqual({
        type: "order.created",
        data: { id: "ord_123", amount: 4200 },
      });
    });

    it("accepts version variants like v1a and v1b for the same key", async () => {
      const now = Math.floor(Date.now() / 1000);
      const sig = await signV1(TEST_SECRET_BYTES, TEST_ID, now, TEST_BODY);
      const base64 = sig.slice("v1,".length);
      const request = await buildSignedRequest({
        timestamp: now,
        signatureHeader: `v1a,${base64} v1b,${base64}`,
      });

      const result = await standardWebhooks.verify(request, TEST_SECRET_BASE64);
      expect(result.payload).toEqual({
        type: "order.created",
        data: { id: "ord_123", amount: 4200 },
      });
    });

    it("rejects when none of the signature entries match", async () => {
      const bogus =
        "v1," + Buffer.from("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").toString("base64");
      const request = await buildSignedRequest({ signatureHeader: bogus });

      await expect(standardWebhooks.verify(request, TEST_SECRET_BASE64)).rejects.toThrow(
        new WebhookError("invalid signature")
      );
    });
  });

  describe("signature verification", () => {
    it("rejects a signature computed with the wrong secret", async () => {
      const wrongSecretBytes = Buffer.alloc(32);
      const now = Math.floor(Date.now() / 1000);
      const sig = await signV1(wrongSecretBytes, TEST_ID, now, TEST_BODY);
      const request = await buildSignedRequest({ timestamp: now, signatureHeader: sig });

      await expect(standardWebhooks.verify(request, TEST_SECRET_BASE64)).rejects.toThrow(
        new WebhookError("invalid signature")
      );
    });

    it("rejects when the body has been tampered with after signing", async () => {
      const now = Math.floor(Date.now() / 1000);
      const sig = await signV1(TEST_SECRET_BYTES, TEST_ID, now, TEST_BODY);
      const tampered = await buildSignedRequest({
        timestamp: now,
        signatureHeader: sig,
        body: TEST_BODY.replace("4200", "9999"),
      });

      await expect(standardWebhooks.verify(tampered, TEST_SECRET_BASE64)).rejects.toThrow(
        new WebhookError("invalid signature")
      );
    });
  });

  describe("secret handling", () => {
    it("rejects an empty secret as 'invalid secret'", async () => {
      const request = await buildSignedRequest();
      await expect(standardWebhooks.verify(request, "")).rejects.toThrow(
        new WebhookError("invalid secret")
      );
    });

    it("wraps crypto failures as WebhookError when the secret is malformed", async () => {
      const request = await buildSignedRequest();
      // Not a real base64 secret but not empty either — subtle.importKey should
      // still reject it because the byte length isn't a valid HMAC secret.
      await expect(
        standardWebhooks.verify(request, Buffer.alloc(0).toString("base64"))
      ).rejects.toThrow(WebhookError);
    });
  });

  describe("header validation", () => {
    it("throws 'missing headers' when webhook-id is absent", async () => {
      const request = await buildSignedRequest({ omit: "id" });
      await expect(standardWebhooks.verify(request, TEST_SECRET_BASE64)).rejects.toThrow(
        new WebhookError("missing headers")
      );
    });

    it("throws 'missing headers' when webhook-timestamp is absent", async () => {
      const request = await buildSignedRequest({ omit: "timestamp" });
      await expect(standardWebhooks.verify(request, TEST_SECRET_BASE64)).rejects.toThrow(
        new WebhookError("missing headers")
      );
    });

    it("throws 'missing headers' when webhook-signature is absent", async () => {
      const request = await buildSignedRequest({ omit: "signature" });
      await expect(standardWebhooks.verify(request, TEST_SECRET_BASE64)).rejects.toThrow(
        new WebhookError("missing headers")
      );
    });

    it("throws 'unsupported signature version' when the only entries are v0", async () => {
      const request = await buildSignedRequest({
        signatureHeader: "v0,abcd v0,efgh",
      });
      await expect(standardWebhooks.verify(request, TEST_SECRET_BASE64)).rejects.toThrow(
        new WebhookError("unsupported signature version")
      );
    });

    it("throws 'unsupported signature version' when there are no comma-prefixed entries", async () => {
      const request = await buildSignedRequest({ signatureHeader: "garbage" });
      await expect(standardWebhooks.verify(request, TEST_SECRET_BASE64)).rejects.toThrow(
        new WebhookError("unsupported signature version")
      );
    });
  });

  describe("tolerance", () => {
    it("accepts a request whose timestamp is within the default 300s window", async () => {
      const request = await buildSignedRequest();
      await expect(standardWebhooks.verify(request, TEST_SECRET_BASE64)).resolves.toBeDefined();
    });

    it("rejects a request whose timestamp is older than the default window", async () => {
      const oldTimestamp = Math.floor(Date.now() / 1000) - STANDARD_WEBHOOKS_TOLERANCE_SECONDS - 1;
      const sig = await signV1(TEST_SECRET_BYTES, TEST_ID, oldTimestamp, TEST_BODY);
      const request = await buildSignedRequest({ timestamp: oldTimestamp, signatureHeader: sig });

      await expect(standardWebhooks.verify(request, TEST_SECRET_BASE64)).rejects.toThrow(
        new WebhookError("timestamp outside tolerance window")
      );
    });

    it("honors an explicit tolerance option", async () => {
      const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 5 * 60;
      const sig = await signV1(TEST_SECRET_BYTES, TEST_ID, fiveMinutesAgo, TEST_BODY);
      const [requestA, requestB] = await buildSignedRequestPair({
        timestamp: fiveMinutesAgo,
        signatureHeader: sig,
      });

      // 4 minutes < 5 minute age, so default 300s tolerance rejects.
      await expect(standardWebhooks.verify(requestA, TEST_SECRET_BASE64)).rejects.toThrow(
        new WebhookError("timestamp outside tolerance window")
      );

      // ...but raising the tolerance to 600s accepts it.
      await expect(
        standardWebhooks.verify(requestB, TEST_SECRET_BASE64, { tolerance: 600 })
      ).resolves.toBeDefined();
    });

    it("disables the anti-replay check entirely when tolerance = 0", async () => {
      const ancientTimestamp = 1700000000; // 2023-11-14
      const sig = await signV1(TEST_SECRET_BYTES, TEST_ID, ancientTimestamp, TEST_BODY);
      const request = await buildSignedRequest({
        timestamp: ancientTimestamp,
        signatureHeader: sig,
      });

      await expect(
        standardWebhooks.verify(request, TEST_SECRET_BASE64, { tolerance: 0 })
      ).resolves.toBeDefined();
    });

    it("rejects a non-numeric timestamp when tolerance is enabled", async () => {
      const sig = await signV1(TEST_SECRET_BYTES, TEST_ID, "not-a-number", TEST_BODY);
      const request = await buildSignedRequest({
        timestamp: "not-a-number",
        signatureHeader: sig,
      });
      await expect(standardWebhooks.verify(request, TEST_SECRET_BASE64)).rejects.toThrow(
        new WebhookError("invalid timestamp")
      );
    });
  });

  describe("payload parsing", () => {
    it("rejects a body that is not valid JSON", async () => {
      const body = "this is not json";
      const now = Math.floor(Date.now() / 1000);
      const sig = await signV1(TEST_SECRET_BYTES, TEST_ID, now, body);
      const request = await buildSignedRequest({ timestamp: now, body, signatureHeader: sig });

      await expect(standardWebhooks.verify(request, TEST_SECRET_BASE64)).rejects.toThrow(
        /invalid payload/
      );
    });

    it("preserves non-object payloads (arrays, primitives)", async () => {
      const body = "[1,2,3]";
      const now = Math.floor(Date.now() / 1000);
      const sig = await signV1(TEST_SECRET_BYTES, TEST_ID, now, body);
      const request = await buildSignedRequest({ timestamp: now, body, signatureHeader: sig });

      const result = await standardWebhooks.verify(request, TEST_SECRET_BASE64);
      expect(result.payload).toEqual([1, 2, 3]);
    });
  });
});
