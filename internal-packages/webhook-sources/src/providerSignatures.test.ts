import { verify } from "@internal/webhook-engine";
import { webhookProviderConfigs, type WebhookProviderId } from "@trigger.dev/core/webhooks";
import { describe, expect, it } from "vitest";

/**
 * Provider wire-format fixtures. Each signature literal was produced by the provider's own documented
 * signing code (linked per fixture), not by our signer, so these check that our config matches what
 * the provider sends. Metronome's is the test vector published in its docs; the rest are synthetic
 * deliveries built by reproducing each provider's signing snippet over a fixed body, secret and clock.
 */
type Fixture = {
  provider: WebhookProviderId;
  /** Test label when a provider has more than one fixture. */
  label?: string;
  /** Where the signing algorithm the fixture reproduces is documented. */
  source: string;
  body: string;
  secret: string;
  headers: Record<string, string>;
  nowMs: number;
  /** Seconds after `nowMs` at which the signature must stop verifying, for configs with a window. */
  toleranceSeconds?: number;
  /** False for a shared secret, which authenticates the sender but does not cover the body. */
  signsBody?: boolean;
};

const T = 1_791_000_000;
const NOW_MS = T * 1000;

const fixtures: Fixture[] = [
  {
    provider: "metronome",
    source: "https://docs.metronome.com/guides/platform-configuration/setup-webhooks",
    body: JSON.stringify(
      {
        id: "b2c9e307-624e-4e7d-a5a4-1b74107d78c4",
        type: "widget_created",
        properties: {
          customer_id: "5f794d50-085a-4db6-8d15-286e518b7225",
          widget_id: "0891458d-b6f0-4fdd-a41e-380aae1a1e38",
        },
      },
      null,
      2
    ),
    secret: "correct-horse-battery-staple",
    headers: {
      "x-metronome-date": "Mon, 02 Jan 2006 22:04:05 GMT",
      "metronome-webhook-signature":
        "b82652fa2246cf1d8a27e591f155c865f68b46c19b9213fd9c052f2419b4742b",
    },
    nowMs: Date.parse("Mon, 02 Jan 2006 22:04:05 GMT"),
    toleranceSeconds: 300,
  },
  {
    provider: "metronome",
    label: "metronome (legacy Date header only)",
    source: "https://docs.metronome.com/guides/platform-configuration/setup-webhooks",
    body: JSON.stringify(
      {
        id: "b2c9e307-624e-4e7d-a5a4-1b74107d78c4",
        type: "widget_created",
        properties: {
          customer_id: "5f794d50-085a-4db6-8d15-286e518b7225",
          widget_id: "0891458d-b6f0-4fdd-a41e-380aae1a1e38",
        },
      },
      null,
      2
    ),
    secret: "correct-horse-battery-staple",
    headers: {
      date: "Mon, 02 Jan 2006 22:04:05 GMT",
      "metronome-webhook-signature":
        "b82652fa2246cf1d8a27e591f155c865f68b46c19b9213fd9c052f2419b4742b",
    },
    nowMs: Date.parse("Mon, 02 Jan 2006 22:04:05 GMT"),
    toleranceSeconds: 300,
  },
  {
    provider: "mux",
    source: "https://www.mux.com/docs/core/verify-webhook-signatures",
    body: '{"type":"video.asset.ready","id":"evt_fixture","data":{"id":"asset_fixture"}}',
    secret: "mux_fixture_secret",
    headers: {
      "mux-signature":
        "t=1791000000,v1=da83ac7503a125ccb309dcc5b2eda31985b72ccfe2488b9c366031ac9eb99abb",
    },
    nowMs: NOW_MS,
    toleranceSeconds: 300,
  },
  {
    provider: "tailscale",
    source: "https://github.com/tailscale/tailscale/blob/main/docs/webhooks/example.go",
    body: '[{"timestamp":"2026-10-15T12:00:00Z","version":1,"type":"test","tailnet":"example.com","message":"This is a test event","data":null}]',
    secret: "tskey-webhook-fixture",
    headers: {
      "tailscale-webhook-signature":
        "t=1791000000,v1=42a31ce54f0cb03c440cb41b61dde21a2dbcd65c94feb3141b42e16f85a865bb",
    },
    nowMs: NOW_MS,
    toleranceSeconds: 300,
  },
  {
    provider: "langfuse",
    source:
      "https://github.com/langfuse/langfuse/blob/main/packages/shared/src/encryption/signature.ts",
    body: '{"id":"exec_fixture","timestamp":"2026-10-15T12:00:00.000Z","type":"prompt-version","apiVersion":"v1","action":"created","prompt":{"name":"Zoë","version":1}}',
    secret: `lf-whsec_${"a".repeat(64)}`,
    headers: {
      "x-langfuse-signature":
        "t=1791000000,v1=3e4de3ed63932fcb35929015ce08d624f5906dabfd2582868e8ccf7ff38a4811",
    },
    nowMs: NOW_MS,
  },
  {
    provider: "infisical",
    source:
      "https://github.com/Infisical/infisical/blob/main/backend/src/services/webhook/webhook-fns.ts",
    body: '{"event":"secrets.modified","project":{"workspaceId":"ws_fixture","environment":"dev","secretPath":"/"},"timestamp":1791000000123}',
    secret: "infisical_fixture_secret",
    headers: {
      "x-infisical-signature":
        "t=1791000000123;da0d2339162e8fddfad6bdd80d280bc0109e65dd12249d238de0388505b78a0f",
    },
    nowMs: NOW_MS,
  },
  {
    provider: "planetscale",
    source: "https://planetscale.com/docs/api/webhooks",
    body: '{"timestamp":1791000000,"event":"branch.ready","organization":"acme","database":"app","resource":{"name":"main"}}',
    secret: "pscale_fixture_secret",
    headers: {
      "x-planetscale-signature": "618baa9eb83b0fd61ee2b2335f3b68a71ddc75c6d1496bb2e32f73b8735dfcd8",
    },
    nowMs: NOW_MS,
  },
  {
    provider: "plain",
    source: "https://www.plain.com/docs/api-reference/webhooks",
    body: '{"id":"pEv_fixture","type":"thread.thread_created","webhookMetadata":{"webhookDeliveryAttemptTimestamp":"2026-10-03T04:00:00.000Z"},"payload":{"eventType":"thread.thread_created"}}',
    secret: "plainhmac_fixture",
    headers: {
      "plain-request-signature": "0b06ba6cb92f81125fdcb8f9b5bba84b996ae258d69b2152bc92e00dc2855498",
    },
    nowMs: NOW_MS,
    toleranceSeconds: 300,
  },
  {
    provider: "firecrawl",
    source: "https://docs.firecrawl.dev/webhooks/security",
    body: '{"success":true,"type":"crawl.completed","id":"job_fixture","data":[],"metadata":{}}',
    secret: "fc_fixture_secret",
    headers: {
      "x-firecrawl-signature":
        "sha256=68dcd0f189d511194667e26199f9fa9c55ff891d3b45ea292c272b220af79a9e",
    },
    nowMs: NOW_MS,
  },
  {
    provider: "loops",
    source: "https://loops.so/docs/webhooks",
    body: '{"fixture":"loops","name":"Zoë"}',
    secret: "whsec_bG9vcHMtZml4dHVyZS1zaWduaW5nLWtleQ==",
    headers: {
      "webhook-id": "msg_loops_fixture",
      "webhook-timestamp": String(T),
      "webhook-signature": "v1,q8flH1wVnAroAJAg2J1SscVqSMMMGlpE1wGwzkR622s=",
    },
    nowMs: NOW_MS,
    toleranceSeconds: 300,
  },
  {
    provider: "granola",
    source: "https://docs.granola.ai/webhooks",
    body: '{"fixture":"granola","name":"Zoë"}',
    secret: "whsec_Z3Jhbm9sYS1maXh0dXJlLXNpZ25pbmcta2V5",
    headers: {
      "webhook-id": "msg_granola_fixture",
      "webhook-timestamp": String(T),
      "webhook-signature": "v1,KNe4k28uHtwErfBiRXU1TiBfPLhDM02q6kX2biZEXzY=",
    },
    nowMs: NOW_MS,
    toleranceSeconds: 300,
  },
  {
    provider: "autumn",
    source: "https://docs.svix.com/receiving/verifying-payloads/how-manual",
    body: '{"fixture":"autumn","name":"Zoë"}',
    secret: "whsec_YXV0dW1uLWZpeHR1cmUtc2lnbmluZy1rZXk=",
    headers: {
      "svix-id": "msg_autumn_fixture",
      "svix-timestamp": String(T),
      "svix-signature": "v1,3y5xmClxq8IOVa45ryHMO2CpLW3M7tTnI/KQKPHXr2k=",
    },
    nowMs: NOW_MS,
    toleranceSeconds: 300,
  },
  {
    provider: "supabase",
    source: "https://supabase.com/docs/guides/database/webhooks",
    body: '{"type":"INSERT","table":"orders","schema":"public","record":{"id":1},"old_record":null}',
    secret: "supabase_fixture_secret",
    headers: { authorization: "Bearer supabase_fixture_secret" },
    nowMs: NOW_MS,
    signsBody: false,
  },
];

function verifyFixture(
  fixture: Fixture,
  overrides: { body?: string; secret?: string; nowMs?: number } = {}
) {
  return verify(
    { kind: "config", config: webhookProviderConfigs[fixture.provider].config() },
    {
      rawBytes: new TextEncoder().encode(overrides.body ?? fixture.body),
      secret: overrides.secret ?? fixture.secret,
      nowMs: overrides.nowMs ?? fixture.nowMs,
      headers: fixture.headers,
      url: `https://example.com/webhooks/v1/ingest/${fixture.provider}_fixture`,
    }
  );
}

describe("provider signature compatibility", () => {
  for (const fixture of fixtures) {
    describe(fixture.label ?? fixture.provider, () => {
      it("accepts the provider's signature over the exact raw bytes", () => {
        expect(verifyFixture(fixture).ok).toBe(true);
      });

      it("rejects a wrong secret", () => {
        expect(verifyFixture(fixture, { secret: "wrong_secret" }).ok).toBe(false);
      });

      if (fixture.signsBody !== false) {
        it("rejects a changed body", () => {
          expect(verifyFixture(fixture, { body: `${fixture.body} ` }).ok).toBe(false);
        });
      }

      if (fixture.toleranceSeconds !== undefined) {
        const windowMs = fixture.toleranceSeconds * 1000;
        it(`rejects a signature outside the ${fixture.toleranceSeconds}s window`, () => {
          expect(verifyFixture(fixture, { nowMs: fixture.nowMs + windowMs }).ok).toBe(true);
          expect(verifyFixture(fixture, { nowMs: fixture.nowMs + windowMs + 1000 }).ok).toBe(false);
        });
      }
    });
  }
});
