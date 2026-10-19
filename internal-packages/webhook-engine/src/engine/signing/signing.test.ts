import type {
  WebhookAsymmetricConfig,
  WebhookHmacConfig,
  WebhookSharedSecretConfig,
  WebhookUrlSecretConfig,
  WebhookVerifierConfig,
} from "@trigger.dev/core/v3";
import { webhookProviderConfigs } from "@trigger.dev/core/webhooks";
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

  it("linear: refreshBodyTimestamp re-signs a recorded body as of now, so it verifies on the current clock", () => {
    const linear = webhookProviderConfigs.linear.config();
    const recorded = new TextEncoder().encode(
      JSON.stringify({ action: "create", type: "Comment", webhookTimestamp: 1751380338084 })
    );
    const secret = "lin_wh_secret";

    const stale = signWithVerifierConfig({
      config: linear,
      secret,
      rawBody: recorded,
      url: INGRESS_URL,
      nowMs: NOW,
    });
    if (!stale.ok) throw new Error(stale.error);
    const staleVerdict = verify(
      { kind: "config", config: linear },
      { rawBytes: stale.body, headers: stale.headers, url: stale.url, secret, nowMs: NOW }
    );
    expect(staleVerdict.ok).toBe(false);
    if (!staleVerdict.ok) expect(staleVerdict.error).toMatch(/timestamp/i);

    const fresh = signWithVerifierConfig({
      config: linear,
      secret,
      rawBody: recorded,
      url: INGRESS_URL,
      nowMs: NOW,
      refreshBodyTimestamp: true,
    });
    if (!fresh.ok) throw new Error(fresh.error);
    const body = JSON.parse(new TextDecoder().decode(fresh.body));
    expect(body.webhookTimestamp).toBe(NOW);
    expect(body.type).toBe("Comment");
    const freshVerdict = verify(
      { kind: "config", config: linear },
      { rawBytes: fresh.body, headers: fresh.headers, url: fresh.url, secret, nowMs: NOW }
    );
    expect(freshVerdict.ok).toBe(true);
  });

  it("http-date: writes an HTTP date to the timestamp header and signs that same value", () => {
    const metronome: WebhookHmacConfig = {
      scheme: "hmac",
      algorithm: "sha256",
      encoding: "hex",
      signatureHeader: "metronome-webhook-signature",
      signature: {},
      timestamp: {
        source: { from: "header", name: "x-metronome-date" },
        format: "http-date",
        toleranceSeconds: 300,
      },
      signingString: {
        template: "{date}\n{body}",
        vars: { date: { from: "header", name: "x-metronome-date" } },
      },
    };
    const secret = "metronome_secret";
    const signed = signWithVerifierConfig({
      config: metronome,
      secret,
      rawBody: BODY,
      url: INGRESS_URL,
      nowMs: NOW,
    });
    if (!signed.ok) throw new Error(signed.error);
    expect(signed.headers["x-metronome-date"]).toBe(new Date(NOW).toUTCString());
    const verdict = (nowMs: number) =>
      verify(
        { kind: "config", config: metronome },
        { rawBytes: signed.body, headers: signed.headers, url: signed.url, secret, nowMs }
      ).ok;
    expect(verdict(NOW)).toBe(true);
    expect(verdict(NOW + 301_000)).toBe(false);
  });

  it("signs a header var from its fallback header and writes it under the primary name", () => {
    const config: WebhookHmacConfig = {
      scheme: "hmac",
      algorithm: "sha256",
      encoding: "hex",
      signatureHeader: "x-signature",
      signature: {},
      signingString: {
        template: "{date}\n{body}",
        vars: { date: { from: "header", name: "x-provider-date", fallback: ["date"] } },
      },
    };
    const date = "Thu, 15 Oct 2026 12:00:00 GMT";
    const signed = signWithVerifierConfig({
      config,
      secret: "s",
      rawBody: BODY,
      url: INGRESS_URL,
      headers: { date },
      nowMs: NOW,
    });
    if (!signed.ok) throw new Error(signed.error);
    expect(signed.headers["x-provider-date"]).toBe(date);
    const verdict = verify(
      { kind: "config", config },
      {
        rawBytes: signed.body,
        headers: { date, "x-signature": signed.headers["x-signature"]! },
        url: signed.url,
        secret: "s",
        nowMs: NOW,
      }
    );
    expect(verdict.ok).toBe(true);
  });

  it("iso8601: refreshBodyTimestamp writes an ISO 8601 delivery time, so a recorded sample verifies now", () => {
    const plain: WebhookHmacConfig = {
      scheme: "hmac",
      algorithm: "sha256",
      encoding: "hex",
      signatureHeader: "plain-request-signature",
      signature: {},
      timestamp: {
        source: { from: "body", path: "webhookMetadata.webhookDeliveryAttemptTimestamp" },
        format: "iso8601",
        toleranceSeconds: 300,
      },
      signingString: "raw",
    };
    const secret = "plain_secret";
    const recorded = new TextEncoder().encode(
      JSON.stringify({
        id: "pEv_1",
        type: "thread.thread_created",
        webhookMetadata: { webhookDeliveryAttemptTimestamp: "2026-01-01T00:00:00.000Z" },
      })
    );
    const signed = signWithVerifierConfig({
      config: plain,
      secret,
      rawBody: recorded,
      url: INGRESS_URL,
      nowMs: NOW,
      refreshBodyTimestamp: true,
    });
    if (!signed.ok) throw new Error(signed.error);
    const body = JSON.parse(new TextDecoder().decode(signed.body));
    expect(body.webhookMetadata.webhookDeliveryAttemptTimestamp).toBe(new Date(NOW).toISOString());
    const verdict = verify(
      { kind: "config", config: plain },
      { rawBytes: signed.body, headers: signed.headers, url: signed.url, secret, nowMs: NOW }
    );
    expect(verdict.ok).toBe(true);
  });

  it.each(["1751380338084", 1751380338084])(
    "refreshBodyTimestamp preserves the existing scalar type: %j",
    (timestamp) => {
      const config = webhookProviderConfigs.linear.config();
      const signed = signWithVerifierConfig({
        config,
        secret: "secret",
        rawBody: new TextEncoder().encode(JSON.stringify({ webhookTimestamp: timestamp })),
        url: INGRESS_URL,
        nowMs: NOW,
        refreshBodyTimestamp: true,
      });
      if (!signed.ok) throw new Error(signed.error);
      expect(JSON.parse(new TextDecoder().decode(signed.body)).webhookTimestamp).toBe(
        typeof timestamp === "string" ? String(NOW) : NOW
      );
      expect(
        verify(
          { kind: "config", config },
          {
            rawBytes: signed.body,
            headers: signed.headers,
            url: signed.url,
            secret: "secret",
            nowMs: NOW,
          }
        ).ok
      ).toBe(true);
    }
  );

  it.each([{}, { webhookTimestamp: null }, { webhookTimestamp: {} }])(
    "refreshBodyTimestamp leaves missing or non-scalar timestamps unchanged: %j",
    (body) => {
      const rawBody = new TextEncoder().encode(JSON.stringify(body));
      const signed = signWithVerifierConfig({
        config: webhookProviderConfigs.linear.config(),
        secret: "secret",
        rawBody,
        url: INGRESS_URL,
        nowMs: NOW,
        refreshBodyTimestamp: true,
      });
      if (!signed.ok) throw new Error(signed.error);
      expect(signed.body).toEqual(rawBody);
    }
  );

  it("linear: the idempotency key comes from the signed bytes, so a replay with a different delivery header dedupes", () => {
    const linear = webhookProviderConfigs.linear.config();
    const body = new TextEncoder().encode(
      JSON.stringify({ action: "create", type: "Comment", webhookTimestamp: NOW })
    );
    const secret = "lin_wh_secret";
    const signed = signWithVerifierConfig({
      config: linear,
      secret,
      rawBody: body,
      url: INGRESS_URL,
      nowMs: NOW,
    });
    if (!signed.ok) throw new Error(signed.error);
    const first = verify(
      { kind: "config", config: linear },
      {
        rawBytes: signed.body,
        headers: { ...signed.headers, "linear-delivery": "a" },
        url: signed.url,
        secret,
        nowMs: NOW,
      }
    );
    const replay = verify(
      { kind: "config", config: linear },
      {
        rawBytes: signed.body,
        headers: { ...signed.headers, "linear-delivery": "b" },
        url: signed.url,
        secret,
        nowMs: NOW,
      }
    );
    expect(first.ok && replay.ok).toBe(true);
    if (first.ok && replay.ok) expect(replay.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("refreshBodyTimestamp never writes through the prototype chain", () => {
    const original = Object.prototype.toString;
    const config: WebhookHmacConfig = {
      ...webhookProviderConfigs.linear.config(),
      timestamp: {
        source: { from: "body", path: "__proto__.toString" },
        unit: "milliseconds",
        toleranceSeconds: 60,
      },
    } as WebhookHmacConfig;
    const body = new TextEncoder().encode(JSON.stringify({ webhookTimestamp: 1 }));
    const signed = signWithVerifierConfig({
      config,
      secret: "s",
      rawBody: body,
      url: INGRESS_URL,
      nowMs: NOW,
      refreshBodyTimestamp: true,
    });
    expect(signed.ok).toBe(true);
    if (signed.ok)
      expect(new TextDecoder().decode(signed.body)).toBe(JSON.stringify({ webhookTimestamp: 1 }));
    expect(Object.prototype.toString).toBe(original);
    expect({}.toString()).toBe("[object Object]");
  });

  describe("form-encoded bodies", () => {
    const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };
    const formBody = (fields: string) => new TextEncoder().encode(fields);
    const bodyTimestamped: WebhookHmacConfig = {
      scheme: "hmac",
      algorithm: "sha256",
      encoding: "hex",
      signatureHeader: "x-signature",
      signature: {},
      timestamp: { source: { from: "body", path: "ts" }, toleranceSeconds: 300 },
      signingString: { template: "{timestamp}.{body}" },
    };

    function verifySigned(
      config: WebhookVerifierConfig,
      secret: string,
      signed: ReturnType<typeof signWithVerifierConfig>
    ) {
      if (!signed.ok) throw new Error(`expected signable: ${signed.error}`);
      return verify(
        { kind: "config", config },
        { rawBytes: signed.body, headers: signed.headers, url: signed.url, secret, nowMs: NOW }
      );
    }

    it("signs a form field timestamp the verifier reads back", () => {
      const secret = "form-secret";
      const signed = signWithVerifierConfig({
        config: bodyTimestamped,
        secret,
        rawBody: formBody(`ts=${NOW / 1000}&message=hello`),
        headers: FORM_HEADERS,
        url: INGRESS_URL,
        nowMs: NOW,
      });
      const verdict = verifySigned(bodyTimestamped, secret, signed);
      expect(verdict.ok).toBe(true);
      expect(verdict.parsedEvent).toEqual({ ts: String(NOW / 1000), message: "hello" });
    });

    it("refreshes a stale form field timestamp and keeps the body a form", () => {
      const secret = "form-secret";
      const signed = signWithVerifierConfig({
        config: bodyTimestamped,
        secret,
        rawBody: formBody("ts=1700000000&message=hello+there&tag=a&tag=b"),
        headers: FORM_HEADERS,
        url: INGRESS_URL,
        nowMs: NOW,
        refreshBodyTimestamp: true,
      });
      const verdict = verifySigned(bodyTimestamped, secret, signed);
      expect(verdict.ok).toBe(true);
      expect(verdict.parsedEvent).toEqual({
        ts: String(NOW / 1000),
        message: "hello there",
        tag: ["a", "b"],
      });
    });

    it("places a body shared secret into a form body", () => {
      const config: WebhookSharedSecretConfig = {
        scheme: "shared-secret",
        placement: "body",
        fieldName: "token",
      };
      const signed = signWithVerifierConfig({
        config,
        secret: "the-shared-secret",
        rawBody: formBody("command=%2Fmiphy&text=hi"),
        headers: FORM_HEADERS,
        url: INGRESS_URL,
        nowMs: NOW,
      });
      const verdict = verifySigned(config, "the-shared-secret", signed);
      expect(verdict.ok).toBe(true);
      expect(verdict.parsedEvent).toMatchObject({ command: "/miphy", text: "hi" });
    });
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
