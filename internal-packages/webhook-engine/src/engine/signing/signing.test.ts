import type {
  WebhookAsymmetricConfig,
  WebhookHmacConfig,
  WebhookSharedSecretConfig,
  WebhookUrlSecretConfig,
  WebhookVerifierConfig,
} from "@trigger.dev/core/v3";
import { describe, expect, it } from "vitest";
import { verify } from "../verification/index.js";
import { signWithVerifierConfig } from "./index.js";

const INGRESS_URL = "https://example.com/webhooks/v1/ingest/opaque123";
const NOW = 1783000000000;
const BODY = new TextEncoder().encode(
  JSON.stringify({ id: "evt_123", event_id: "sqevt_123", type: "test.event" })
);

function roundTrip(config: WebhookVerifierConfig, secret: string) {
  const signed = signWithVerifierConfig({
    config,
    secret,
    rawBody: BODY,
    url: INGRESS_URL,
    nowMs: NOW,
  });
  if (!signed.ok) throw new Error(`expected signable: ${signed.error}`);
  return verify(
    { kind: "config", config },
    { rawBytes: signed.body, headers: signed.headers, url: signed.url, secret, nowMs: NOW }
  );
}

const stripe: WebhookHmacConfig = {
  scheme: "hmac",
  algorithm: "sha256",
  encoding: "hex",
  signatureHeader: "stripe-signature",
  signature: { itemSeparator: ",", fieldSeparator: "=", field: "v1" },
  timestamp: { source: { from: "signatureField", field: "t" }, toleranceSeconds: 300 },
  signingString: { template: "{timestamp}.{body}" },
  idempotencyField: { from: "body", name: "id" },
};

const github: WebhookHmacConfig = {
  scheme: "hmac",
  algorithm: "sha256",
  encoding: "hex",
  signatureHeader: "x-hub-signature-256",
  signature: { fieldSeparator: "=", field: "sha256" },
  signingString: "raw",
  idempotencyField: { from: "header", name: "x-github-delivery" },
};

const svix: WebhookHmacConfig = {
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
};

const square: WebhookHmacConfig = {
  scheme: "hmac",
  algorithm: "sha256",
  encoding: "base64",
  signatureHeader: "x-square-hmacsha256-signature",
  signature: {},
  signingString: { template: "{url}{body}", vars: { url: { from: "url" } } },
  idempotencyField: { from: "body", name: "event_id" },
};

const discord: WebhookAsymmetricConfig = {
  scheme: "asymmetric",
  algorithm: "ed25519",
  encoding: "hex",
  signatureHeader: "x-signature-ed25519",
  signature: {},
  timestamp: { source: { from: "header", name: "x-signature-timestamp" } },
  signingString: { template: "{timestamp}{body}" },
  publicKeyEncoding: "raw-hex",
};

const svixSecret = `whsec_${Buffer.from("svix-signing-key").toString("base64")}`;

describe("signWithVerifierConfig round-trips through the verifier", () => {
  it("custom hmac (raw body, bare signature) — the demo-webhook shape", () => {
    const custom: WebhookHmacConfig = {
      scheme: "hmac",
      algorithm: "sha256",
      encoding: "hex",
      signatureHeader: "x-webhook-signature",
      signature: {},
      signingString: "raw",
    };
    expect(roundTrip(custom, "shhh-custom-secret").ok).toBe(true);
  });

  it("stripe (hex, t=..,v1=.. with signatureField timestamp)", () => {
    expect(roundTrip(stripe, "whsec_stripe_test").ok).toBe(true);
  });

  it("github (prefixed sha256=<hex>, raw body)", () => {
    expect(roundTrip(github, "github_integrator_secret").ok).toBe(true);
  });

  it("svix (base64 v1,<b64>, header timestamp + id var, whsec base64 secret)", () => {
    expect(roundTrip(svix, svixSecret).ok).toBe(true);
  });

  it("square (bare base64 over {url}{body})", () => {
    expect(roundTrip(square, "square_signature_key").ok).toBe(true);
  });

  it("shared-secret header / bearer / basic / body all verify", () => {
    const placements: WebhookSharedSecretConfig["placement"][] = [
      "header",
      "bearer",
      "basic",
      "body",
    ];
    for (const placement of placements) {
      const config: WebhookSharedSecretConfig = {
        scheme: "shared-secret",
        placement,
        fieldName:
          placement === "header" ? "x-api-key" : placement === "body" ? "apiKey" : undefined,
      };
      expect(roundTrip(config, "the-shared-secret").ok, `placement=${placement}`).toBe(true);
    }
  });

  it("url-secret query verifies", () => {
    const config: WebhookUrlSecretConfig = {
      scheme: "url-secret",
      placement: "query",
      paramName: "token",
    };
    expect(roundTrip(config, "url-secret-value").ok).toBe(true);
  });

  it("url-secret path is not signable (fixed ingress path)", () => {
    const config: WebhookUrlSecretConfig = {
      scheme: "url-secret",
      placement: "path",
      paramName: "token",
    };
    const r = signWithVerifierConfig({ config, secret: "x", rawBody: BODY, url: INGRESS_URL });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.notSignable).toBe(true);
  });

  it("asymmetric (discord) is not signable (only the public key is held)", () => {
    const r = signWithVerifierConfig({
      config: discord,
      secret: "deadbeef",
      rawBody: BODY,
      url: INGRESS_URL,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.notSignable).toBe(true);
  });
});
