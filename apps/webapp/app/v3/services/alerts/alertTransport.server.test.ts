import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "~/services/secrets/secretStore.server";
import { deliverWebhookPayload, SkipRetryError } from "./alertTransport.server";
import { UnsafeWebhookUrlError, type safeWebhookFetch } from "./safeWebhookFetch.server";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

async function makeSecret() {
  return encryptSecret(ENCRYPTION_KEY, "whsec_test");
}

function fetchWebhookReturning(response: Response): typeof safeWebhookFetch {
  return vi.fn().mockResolvedValue(response);
}

describe("deliverWebhookPayload", () => {
  it.each([401, 403, 404, 410])("throws SkipRetryError on a permanent %d", async (status) => {
    await expect(
      deliverWebhookPayload({
        url: "https://example.com/webhook",
        secret: await makeSecret(),
        encryptionKey: ENCRYPTION_KEY,
        rawPayload: "{}",
        fetchWebhook: fetchWebhookReturning(new Response(null, { status })),
      })
    ).rejects.toThrow(SkipRetryError);
  });

  it("throws SkipRetryError on an unsafe webhook URL", async () => {
    await expect(
      deliverWebhookPayload({
        url: "http://127.0.0.1/webhook",
        secret: await makeSecret(),
        encryptionKey: ENCRYPTION_KEY,
        rawPayload: "{}",
        fetchWebhook: vi.fn().mockRejectedValue(new UnsafeWebhookUrlError("private address")),
      })
    ).rejects.toThrow(SkipRetryError);
  });

  it("throws a retryable Error (not SkipRetryError) on a 5xx response", async () => {
    const promise = deliverWebhookPayload({
      url: "https://example.com/webhook",
      secret: await makeSecret(),
      encryptionKey: ENCRYPTION_KEY,
      rawPayload: "{}",
      fetchWebhook: fetchWebhookReturning(
        new Response(null, { status: 500, statusText: "Internal Server Error" })
      ),
    });

    await expect(promise).rejects.toThrow();
    await expect(promise).rejects.not.toBeInstanceOf(SkipRetryError);
  });

  it.each([400, 408, 422, 425, 429])(
    "treats status %d as retryable, not SkipRetryError",
    async (status) => {
      const promise = deliverWebhookPayload({
        url: "https://example.com/webhook",
        secret: await makeSecret(),
        encryptionKey: ENCRYPTION_KEY,
        rawPayload: "{}",
        fetchWebhook: fetchWebhookReturning(new Response(null, { status })),
      });

      await expect(promise).rejects.toThrow();
      await expect(promise).rejects.not.toBeInstanceOf(SkipRetryError);
    }
  );
});
