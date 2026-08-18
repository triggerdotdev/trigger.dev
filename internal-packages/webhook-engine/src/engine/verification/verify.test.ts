import { createHmac, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verify } from "./index.js";
import type { VerifyInput } from "./types.js";

// Real signatures computed with node:crypto, exercised through the config-driven verifier.
// This is the deferred M5 suite, now grounded in the actual provider header shapes.

const NOW_MS = 1_700_000_000_000; // fixed clock so timestamp-tolerance is deterministic
const NOW_S = Math.floor(NOW_MS / 1000);

function input(
  over: Partial<VerifyInput> & { rawBytes: Uint8Array; headers: Record<string, string> }
): VerifyInput {
  return {
    url: "https://api.example.com/webhooks/v1/ingest/abc",
    secret: "whsec_test_secret",
    nowMs: NOW_MS,
    ...over,
  };
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const cfg = (config: object) => ({ kind: "config" as const, config: config as any });

describe("hmac verifier (config-driven)", () => {
  it("verifies a Stripe-style t=,v1= combined header", () => {
    const body = JSON.stringify({ id: "evt_123", type: "payment_intent.succeeded" });
    const sig = createHmac("sha256", "whsec_test_secret").update(`${NOW_S}.${body}`).digest("hex");
    const result = verify(
      cfg({
        scheme: "hmac",
        algorithm: "sha256",
        encoding: "hex",
        signatureHeader: "stripe-signature",
        signature: { itemSeparator: ",", fieldSeparator: "=", field: "v1" },
        timestamp: { source: { from: "signatureField", field: "t" }, toleranceSeconds: 300 },
        signingString: { template: "{timestamp}.{body}" },
        idempotencyField: { from: "body", name: "id" },
      }),
      input({ rawBytes: bytes(body), headers: { "stripe-signature": `t=${NOW_S},v1=${sig}` } })
    );
    expect(result.ok).toBe(true);
    expect(result.idempotencyKey).toBe("evt_123");
  });

  it("decodes a form-encoded Slack interactivity body via formPayload", () => {
    const interaction = { type: "block_actions", actions: [{ value: "call-1::approve" }] };
    const formBody = `payload=${encodeURIComponent(JSON.stringify(interaction))}`;
    const sig = createHmac("sha256", "whsec_test_secret")
      .update(`v0:${NOW_S}:${formBody}`)
      .digest("hex");
    const result = verify(
      cfg({
        scheme: "hmac",
        algorithm: "sha256",
        encoding: "hex",
        signatureHeader: "x-slack-signature",
        signature: { fieldSeparator: "=", field: "v0" },
        timestamp: {
          source: { from: "header", name: "x-slack-request-timestamp" },
          toleranceSeconds: 300,
        },
        signingString: { template: "v0:{timestamp}:{body}" },
        formPayload: { field: "payload" },
      }),
      input({
        rawBytes: bytes(formBody),
        headers: { "x-slack-signature": `v0=${sig}`, "x-slack-request-timestamp": String(NOW_S) },
      })
    );
    expect(result.ok).toBe(true);
    expect(result.parsedEvent).toEqual(interaction);
  });

  it("rejects a Stripe signature outside the tolerance window", () => {
    const body = "{}";
    const staleT = NOW_S - 10_000;
    const sig = createHmac("sha256", "whsec_test_secret").update(`${staleT}.${body}`).digest("hex");
    const result = verify(
      cfg({
        scheme: "hmac",
        algorithm: "sha256",
        encoding: "hex",
        signatureHeader: "stripe-signature",
        signature: { itemSeparator: ",", fieldSeparator: "=", field: "v1" },
        timestamp: { source: { from: "signatureField", field: "t" }, toleranceSeconds: 300 },
        signingString: { template: "{timestamp}.{body}" },
      }),
      input({ rawBytes: bytes(body), headers: { "stripe-signature": `t=${staleT},v1=${sig}` } })
    );
    expect(result.ok).toBe(false);
  });

  it("accepts any v1 candidate during Stripe key rotation", () => {
    const body = "{}";
    const good = createHmac("sha256", "whsec_test_secret").update(`${NOW_S}.${body}`).digest("hex");
    const result = verify(
      cfg({
        scheme: "hmac",
        algorithm: "sha256",
        encoding: "hex",
        signatureHeader: "stripe-signature",
        signature: { itemSeparator: ",", fieldSeparator: "=", field: "v1" },
        timestamp: { source: { from: "signatureField", field: "t" }, toleranceSeconds: 300 },
        signingString: { template: "{timestamp}.{body}" },
      }),
      input({
        rawBytes: bytes(body),
        headers: { "stripe-signature": `t=${NOW_S},v1=deadbeef,v1=${good}` },
      })
    );
    expect(result.ok).toBe(true);
  });

  it("verifies a GitHub-style sha256= prefixed header over the raw body", () => {
    const body = JSON.stringify({ action: "opened" });
    const sig = createHmac("sha256", "whsec_test_secret").update(body).digest("hex");
    const result = verify(
      cfg({
        scheme: "hmac",
        algorithm: "sha256",
        encoding: "hex",
        signatureHeader: "x-hub-signature-256",
        signature: { fieldSeparator: "=", field: "sha256" },
        signingString: "raw",
        idempotencyField: { from: "header", name: "x-github-delivery" },
      }),
      input({
        rawBytes: bytes(body),
        headers: { "x-hub-signature-256": `sha256=${sig}`, "x-github-delivery": "guid-1" },
      })
    );
    expect(result.ok).toBe(true);
    expect(result.idempotencyKey).toBe("guid-1");
  });

  it("rejects a tampered body", () => {
    const sig = createHmac("sha256", "whsec_test_secret").update("{}").digest("hex");
    const result = verify(
      cfg({
        scheme: "hmac",
        algorithm: "sha256",
        encoding: "hex",
        signatureHeader: "x-hub-signature-256",
        signature: { fieldSeparator: "=", field: "sha256" },
        signingString: "raw",
      }),
      input({
        rawBytes: bytes('{"tampered":true}'),
        headers: { "x-hub-signature-256": `sha256=${sig}` },
      })
    );
    expect(result.ok).toBe(false);
  });

  it("verifies a Svix-style space-list, base64 secret, {id}.{ts}.{body}", () => {
    // Svix secret is whsec_<base64>; the HMAC key is the base64-decoded remainder.
    const keyBytes = Buffer.from("c2VjcmV0LWtleS1ieXRlcw==", "base64");
    const secret = "whsec_c2VjcmV0LWtleS1ieXRlcw==";
    const id = "msg_123";
    const body = JSON.stringify({ hello: "world" });
    const sig = createHmac("sha256", keyBytes).update(`${id}.${NOW_S}.${body}`).digest("base64");
    const result = verify(
      cfg({
        scheme: "hmac",
        algorithm: "sha256",
        encoding: "base64",
        signatureHeader: "svix-signature",
        signature: { itemSeparator: " ", fieldSeparator: ",", field: "v1" },
        timestamp: { source: { from: "header", name: "svix-timestamp" }, toleranceSeconds: 300 },
        signingString: {
          template: "{id}.{timestamp}.{body}",
          vars: { id: { from: "header", name: "svix-id" } },
        },
        secret: { encoding: "base64", stripPrefix: "whsec_" },
        idempotencyField: { from: "header", name: "svix-id" },
      }),
      input({
        rawBytes: bytes(body),
        secret,
        headers: {
          "svix-id": id,
          "svix-timestamp": String(NOW_S),
          "svix-signature": `v1,${sig}`,
        },
      })
    );
    expect(result.ok).toBe(true);
    expect(result.idempotencyKey).toBe(id);
  });

  it("verifies a Square-style {url}{body} signature", () => {
    const url = "https://api.example.com/webhooks/v1/ingest/abc";
    const body = JSON.stringify({ event_id: "sq_1" });
    const sig = createHmac("sha256", "whsec_test_secret").update(`${url}${body}`).digest("base64");
    const result = verify(
      cfg({
        scheme: "hmac",
        algorithm: "sha256",
        encoding: "base64",
        signatureHeader: "x-square-hmacsha256-signature",
        signature: {},
        signingString: { template: "{url}{body}", vars: { url: { from: "url" } } },
        idempotencyField: { from: "body", name: "event_id" },
      }),
      input({ rawBytes: bytes(body), url, headers: { "x-square-hmacsha256-signature": sig } })
    );
    expect(result.ok).toBe(true);
    expect(result.idempotencyKey).toBe("sq_1");
  });
});

describe("asymmetric verifier (config-driven)", () => {
  it("verifies a Discord-style Ed25519 signature with a raw-hex public key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const rawPubHex = rawEd25519PublicKeyHex(publicKey);
    const ts = String(NOW_S);
    const body = JSON.stringify({ type: 1 });
    const sig = cryptoSign(null, Buffer.from(`${ts}${body}`), privateKey).toString("hex");
    const config = {
      scheme: "asymmetric",
      algorithm: "ed25519",
      encoding: "hex",
      signatureHeader: "x-signature-ed25519",
      signature: {},
      timestamp: { source: { from: "header", name: "x-signature-timestamp" } },
      signingString: { template: "{timestamp}{body}" },
      publicKeyEncoding: "raw-hex",
    };
    const ok = verify(
      cfg(config),
      input({
        rawBytes: bytes(body),
        secret: rawPubHex,
        headers: { "x-signature-ed25519": sig, "x-signature-timestamp": ts },
      })
    );
    expect(ok.ok).toBe(true);

    const tampered = verify(
      cfg(config),
      input({
        rawBytes: bytes('{"type":2}'),
        secret: rawPubHex,
        headers: { "x-signature-ed25519": sig, "x-signature-timestamp": ts },
      })
    );
    expect(tampered.ok).toBe(false);
  });

  it("verifies a SendGrid-style ECDSA P-256 signature with an SPKI-DER base64 public key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spkiB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const ts = String(NOW_S);
    const body = JSON.stringify([{ sg_event_id: "e1" }]);
    const sig = cryptoSign("sha256", Buffer.from(`${ts}${body}`), privateKey).toString("base64");
    const result = verify(
      cfg({
        scheme: "asymmetric",
        algorithm: "ecdsa-p256",
        encoding: "base64",
        signatureHeader: "x-twilio-email-event-webhook-signature",
        signature: {},
        timestamp: { source: { from: "header", name: "x-twilio-email-event-webhook-timestamp" } },
        signingString: { template: "{timestamp}{body}" },
        publicKeyEncoding: "spki-der-base64",
      }),
      input({
        rawBytes: bytes(body),
        secret: spkiB64,
        headers: {
          "x-twilio-email-event-webhook-signature": sig,
          "x-twilio-email-event-webhook-timestamp": ts,
        },
      })
    );
    expect(result.ok).toBe(true);
  });
});

describe("adversarial / fail-closed", () => {
  const stripeConfig = {
    scheme: "hmac",
    algorithm: "sha256",
    encoding: "hex",
    signatureHeader: "stripe-signature",
    signature: { itemSeparator: ",", fieldSeparator: "=", field: "v1" },
    timestamp: { source: { from: "signatureField", field: "t" }, toleranceSeconds: 300 },
    signingString: { template: "{timestamp}.{body}" },
  };

  it("rejects a request with no signature header", () => {
    const result = verify(cfg(stripeConfig), input({ rawBytes: bytes("{}"), headers: {} }));
    expect(result.ok).toBe(false);
  });

  it("rejects when the signature field is absent (timestamp only)", () => {
    const result = verify(
      cfg(stripeConfig),
      input({ rawBytes: bytes("{}"), headers: { "stripe-signature": `t=${NOW_S}` } })
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a body signed with the wrong secret", () => {
    const body = "{}";
    const forged = createHmac("sha256", "attacker-secret").update(`${NOW_S}.${body}`).digest("hex");
    const result = verify(
      cfg(stripeConfig),
      input({ rawBytes: bytes(body), headers: { "stripe-signature": `t=${NOW_S},v1=${forged}` } })
    );
    expect(result.ok).toBe(false);
  });

  it("rejects multiple forged signature candidates (no free pass from the list)", () => {
    const result = verify(
      cfg(stripeConfig),
      input({
        rawBytes: bytes("{}"),
        headers: { "stripe-signature": `t=${NOW_S},v1=deadbeef,v1=cafebabe` },
      })
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an empty signature value", () => {
    const result = verify(
      cfg({
        scheme: "hmac",
        algorithm: "sha256",
        encoding: "hex",
        signatureHeader: "x-hub-signature-256",
        signature: { fieldSeparator: "=", field: "sha256" },
        signingString: "raw",
      }),
      input({ rawBytes: bytes("{}"), headers: { "x-hub-signature-256": "sha256=" } })
    );
    expect(result.ok).toBe(false);
  });
});

// Extract the raw 32-byte Ed25519 public key (last 32 bytes of the SPKI DER) as hex.
function rawEd25519PublicKeyHex(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32)).toString("hex");
}
