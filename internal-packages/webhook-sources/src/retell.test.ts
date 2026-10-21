import { verify } from "@internal/webhook-engine";
import { webhookProviderConfigs } from "@trigger.dev/core/webhooks";
import { describe, expect, it } from "vitest";

// Generated with symmetric.sign(body, secret, timestamp) from Retell's official SDK,
// and accepted by symmetric.verify with the same fixed clock. This is a synthetic fixture,
// not a captured delivery. Source: https://github.com/RetellAI/retell-typescript-sdk/blob/73aa9e91516ea727809f4e48def93b952b2d7f0f/src/lib/webhook_auth.ts
// Keep the signature literal: using our own signer would only test internal consistency.
const body =
  '{ "event": "call_started", "call": { "call_id": "call_fixture", "metadata": { "name": "Zoë" } } }';
const secret = "retell_test_key_fixture_only";
const timestamp = 1_700_000_000_123;
const signature =
  "v=1700000000123,d=84bb16158e0a635531e4ea37f164a31c33705f1ca5c80c34a44452ab3be2eb61";

function verifyFixture(overrides: { body?: string; secret?: string; nowMs?: number } = {}) {
  return verify(
    { kind: "config", config: webhookProviderConfigs.retell.config() },
    {
      rawBytes: new TextEncoder().encode(overrides.body ?? body),
      secret: overrides.secret ?? secret,
      nowMs: overrides.nowMs ?? timestamp,
      headers: { "x-retell-signature": signature },
      url: "https://example.com/webhooks/v1/ingest/retell_fixture",
    }
  );
}

describe("Retell official SDK signature compatibility", () => {
  it("accepts the SDK signature over the exact raw bytes and millisecond timestamp", () => {
    expect(verifyFixture().ok).toBe(true);
  });

  it("rejects changed bodies and incorrect API keys", () => {
    expect(verifyFixture({ body: body.replace("call_started", "call_ended") }).ok).toBe(false);
    expect(verifyFixture({ body: JSON.stringify(JSON.parse(body)) }).ok).toBe(false);
    expect(verifyFixture({ secret: "wrong_key" }).ok).toBe(false);
  });

  it("rejects a signature outside the five-minute window", () => {
    expect(verifyFixture({ nowMs: timestamp + 300_000 }).ok).toBe(true);
    expect(verifyFixture({ nowMs: timestamp + 300_001 }).ok).toBe(false);
    expect(verifyFixture({ nowMs: timestamp - 300_001 }).ok).toBe(false);
  });
});
