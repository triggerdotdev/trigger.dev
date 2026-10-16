import { createHmac, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { WebhookVerifierConfig } from "@trigger.dev/core/v3";
import { describe, expect, it } from "vitest";
import { parseEventBody } from "./derive.js";
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

  describe("form-encoded bodies", () => {
    const SLACK_CONFIG = {
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
      idempotencyField: { from: "body", name: "event_id" },
      formPayload: { field: "payload" },
    };

    function slackInput(body: string, contentType?: string) {
      const sig = createHmac("sha256", "whsec_test_secret")
        .update(`v0:${NOW_S}:${body}`)
        .digest("hex");
      return input({
        rawBytes: bytes(body),
        headers: {
          "x-slack-signature": `v0=${sig}`,
          "x-slack-request-timestamp": String(NOW_S),
          ...(contentType ? { "content-type": contentType } : {}),
        },
      });
    }

    const FORM = "application/x-www-form-urlencoded";
    const slashCommand =
      "token=t0k&team_id=T1&channel_id=C1&user_id=U1&command=%2Fmiphy&text=a+raccoon+dancing" +
      "&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2F1%2F2&trigger_id=13.4";

    it("decodes a whole form body (a Slack slash command) when the content type is form-encoded", () => {
      const result = verify(cfg(SLACK_CONFIG), slackInput(slashCommand, `${FORM}; charset=utf-8`));
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.parsedEvent).toEqual({
        token: "t0k",
        team_id: "T1",
        channel_id: "C1",
        user_id: "U1",
        command: "/miphy",
        text: "a raccoon dancing",
        response_url: "https://hooks.slack.com/commands/1/2",
        trigger_id: "13.4",
      });
    });

    it("keeps a slash command's idempotency key stable without an event_id", () => {
      const first = verify(cfg(SLACK_CONFIG), slackInput(slashCommand, FORM));
      const again = verify(cfg(SLACK_CONFIG), slackInput(slashCommand, FORM));
      expect(first.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
      expect(again.idempotencyKey).toBe(first.idempotencyKey);
    });

    it("reads a form field as the idempotency key", () => {
      const result = verify(cfg(SLACK_CONFIG), slackInput(`event_id=Ev1&${slashCommand}`, FORM));
      expect(result.idempotencyKey).toBe("Ev1");
    });

    it("collects a repeated key into an array and keeps __proto__ an ordinary field", () => {
      const result = verify(
        cfg(SLACK_CONFIG),
        slackInput("tag=a&tag=b&tag=c&one=1&__proto__=x", FORM)
      );
      const event = result.parsedEvent as Record<string, unknown>;
      expect(event.tag).toEqual(["a", "b", "c"]);
      expect(event.one).toBe("1");
      expect(Object.getPrototypeOf(event)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(event, "__proto__")?.value).toBe("x");
    });

    it("still decodes the formPayload field ahead of the whole form", () => {
      const interaction = { type: "block_actions", actions: [{ value: "shuffle" }] };
      const body = `payload=${encodeURIComponent(JSON.stringify(interaction))}`;
      const result = verify(cfg(SLACK_CONFIG), slackInput(body, FORM));
      expect(result.parsedEvent).toEqual(interaction);
    });

    it("decodes a form body on a source without formPayload", () => {
      const { formPayload: _, ...noFormPayload } = SLACK_CONFIG;
      const result = verify(cfg(noFormPayload), slackInput("From=%2B15550001&Body=hi+there", FORM));
      expect(result.parsedEvent).toEqual({ From: "+15550001", Body: "hi there" });
    });

    it("matches the form content type whatever the header name's case", () => {
      const parsed = parseEventBody(bytes("command=%2Fmiphy"), {
        headers: { "Content-Type": "Application/X-WWW-Form-Urlencoded; charset=UTF-8" },
      });
      expect(parsed.parsedEvent).toEqual({ command: "/miphy" });
    });

    it("decodes a heavily repeated field in linear time, even on an unsigned request", () => {
      const body = "x=&".repeat(80_000);
      const started = performance.now();
      const parsed = parseEventBody(bytes(body), { headers: { "content-type": FORM } });
      const rejected = verify(
        cfg(SLACK_CONFIG),
        input({ rawBytes: bytes(body), headers: { "content-type": FORM } })
      );
      const elapsedMs = performance.now() - started;
      expect((parsed.parsedEvent as { x: string[] }).x).toHaveLength(80_000);
      expect(rejected.ok).toBe(false);
      expect(elapsedMs).toBeLessThan(3_000);
    });

    it("leaves a non-JSON body unparsed when it isn't sent as a form", () => {
      for (const contentType of [undefined, "text/plain", "application/json"]) {
        const result = verify(cfg(SLACK_CONFIG), slackInput(slashCommand, contentType));
        expect(result.ok).toBe(true);
        expect(result.parsedEvent).toBeUndefined();
        expect(result.error).toBe("verified body is not valid JSON");
      }
    });
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

describe("timestamp formats", () => {
  const SECRET = "whsec_test_secret";
  const hex = (s: string) => createHmac("sha256", SECRET).update(s).digest("hex");

  const HTTP_DATE_CONFIG = {
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

  function httpDateInput(date: string) {
    const body = '{"id":"evt_1","type":"invoice.finalized"}';
    return input({
      rawBytes: bytes(body),
      headers: { "x-metronome-date": date, "metronome-webhook-signature": hex(`${date}\n${body}`) },
    });
  }

  it("accepts an HTTP date inside the window and rejects one outside it", () => {
    const inside = new Date(NOW_MS - 299_000).toUTCString();
    const outside = new Date(NOW_MS - 301_000).toUTCString();
    expect(verify(cfg(HTTP_DATE_CONFIG), httpDateInput(inside)).ok).toBe(true);
    expect(verify(cfg(HTTP_DATE_CONFIG), httpDateInput(outside))).toMatchObject({
      ok: false,
      error: "timestamp outside tolerance",
    });
  });

  it("compares an HTTP date at whole-second resolution, so the window isn't cut short", () => {
    const stamped = new Date(NOW_MS).toUTCString();
    const at = (nowMs: number) =>
      verify(cfg(HTTP_DATE_CONFIG), { ...httpDateInput(stamped), nowMs }).ok;
    expect(at(NOW_MS + 300_900)).toBe(true);
    expect(at(NOW_MS + 301_000)).toBe(false);
  });

  it("refuses an http-date signature field only when the item separator can split a date", () => {
    const withSeparator = (itemSeparator: string) =>
      WebhookVerifierConfig.safeParse({
        scheme: "hmac",
        algorithm: "sha256",
        encoding: "hex",
        signatureHeader: "x-signature",
        signature: { itemSeparator, fieldSeparator: "=", field: "v1" },
        timestamp: { source: { from: "signatureField", field: "t" }, format: "http-date" },
        signingString: { template: "{timestamp}.{body}" },
      }).success;
    expect(withSeparator(",")).toBe(false);
    expect(withSeparator(" ")).toBe(false);
    expect(withSeparator(";")).toBe(true);
    expect(WebhookVerifierConfig.safeParse(HTTP_DATE_CONFIG).success).toBe(true);
  });

  it("reads an HTTP date from a ';'-separated signature header", () => {
    const config = {
      scheme: "hmac",
      algorithm: "sha256",
      encoding: "hex",
      signatureHeader: "x-signature",
      signature: { itemSeparator: ";", fieldSeparator: "=", field: "v1" },
      timestamp: {
        source: { from: "signatureField", field: "t" },
        format: "http-date",
        toleranceSeconds: 300,
      },
      signingString: { template: "{timestamp}.{body}" },
    };
    const date = new Date(NOW_MS).toUTCString();
    const body = '{"id":"evt_1"}';
    const result = verify(
      cfg(config),
      input({
        rawBytes: bytes(body),
        headers: { "x-signature": `t=${date};v1=${hex(`${date}.${body}`)}` },
      })
    );
    expect(result.ok).toBe(true);
  });

  it("keeps a fractional window for an HTTP date slightly in the future", () => {
    const config = {
      ...HTTP_DATE_CONFIG,
      timestamp: { ...HTTP_DATE_CONFIG.timestamp, toleranceSeconds: 0.5 },
    };
    const stamped = new Date(NOW_MS + 1000).toUTCString();
    const at = (nowMs: number) => verify(cfg(config), { ...httpDateInput(stamped), nowMs }).ok;
    expect(at(NOW_MS + 600)).toBe(true);
    expect(at(NOW_MS + 400)).toBe(false);
  });

  it("refuses a value that isn't an HTTP date", () => {
    expect(verify(cfg(HTTP_DATE_CONFIG), httpDateInput("yesterday"))).toMatchObject({
      ok: false,
      error: "unparseable timestamp",
    });
  });

  const ISO_BODY_CONFIG = {
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

  function isoInput(timestamp: string) {
    const body = JSON.stringify({
      id: "pEv_1",
      type: "thread.thread_created",
      webhookMetadata: { webhookDeliveryAttemptTimestamp: timestamp },
    });
    return input({ rawBytes: bytes(body), headers: { "plain-request-signature": hex(body) } });
  }

  it("accepts an ISO 8601 body timestamp inside the window and rejects one outside it", () => {
    expect(
      verify(cfg(ISO_BODY_CONFIG), isoInput(new Date(NOW_MS + 299_000).toISOString())).ok
    ).toBe(true);
    expect(
      verify(cfg(ISO_BODY_CONFIG), isoInput(new Date(NOW_MS + 301_000).toISOString()))
    ).toMatchObject({ ok: false, error: "timestamp outside tolerance" });
  });

  it("refuses an ISO timestamp that doesn't parse, and a unix number is not read as ISO", () => {
    expect(verify(cfg(ISO_BODY_CONFIG), isoInput("not-a-date"))).toMatchObject({
      ok: false,
      error: "unparseable timestamp",
    });
    expect(verify(cfg(ISO_BODY_CONFIG), isoInput(String(NOW_S))).ok).toBe(false);
  });
});

describe("header fallbacks", () => {
  const SECRET = "whsec_test_secret";
  const hex = (s: string) => createHmac("sha256", SECRET).update(s).digest("hex");
  const BODY = '{"id":"evt_1","type":"invoice.finalized"}';
  const DATE = new Date(NOW_MS).toUTCString();

  const CONFIG = {
    scheme: "hmac",
    algorithm: "sha256",
    encoding: "hex",
    signatureHeader: "metronome-webhook-signature",
    signature: {},
    timestamp: {
      source: { from: "header", name: "x-metronome-date", fallback: ["date"] },
      format: "http-date",
      toleranceSeconds: 300,
    },
    signingString: {
      template: "{date}\n{body}",
      vars: { date: { from: "header", name: "x-metronome-date", fallback: ["date"] } },
    },
  };

  const run = (headers: Record<string, string>) =>
    verify(
      cfg(CONFIG),
      input({
        rawBytes: bytes(BODY),
        headers: { "metronome-webhook-signature": hex(`${DATE}\n${BODY}`), ...headers },
      })
    );

  it("reads the primary header when it is set", () => {
    expect(run({ "x-metronome-date": DATE }).ok).toBe(true);
  });

  it("falls back to the next header when the primary is missing or empty", () => {
    expect(run({ date: DATE }).ok).toBe(true);
    expect(run({ "x-metronome-date": "", date: DATE }).ok).toBe(true);
  });

  it("prefers the primary header over the fallback", () => {
    expect(run({ "x-metronome-date": DATE, date: "Mon, 02 Jan 2006 22:04:05 GMT" }).ok).toBe(true);
    expect(run({ "x-metronome-date": "Mon, 02 Jan 2006 22:04:05 GMT", date: DATE }).ok).toBe(false);
  });

  it("fails as a missing timestamp when no listed header is set", () => {
    expect(run({})).toMatchObject({ ok: false, error: "missing timestamp" });
  });
});
