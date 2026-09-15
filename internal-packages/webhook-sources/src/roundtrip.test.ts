import { signWithVerifierConfig, verify } from "@internal/webhook-engine";
import {
  discordVerifierConfig,
  githubVerifierConfig,
  squareVerifierConfig,
  stripeVerifierConfig,
  svixVerifierConfig,
  webhookProviderConfigs,
  type WebhookPresetId,
  type WebhookVerifierConfig,
} from "@trigger.dev/core/webhooks";
import { type SampleRecord as SampleRecordType } from "./sampleRecord.js";
import { describe, expect, it } from "vitest";
import { SampleRecord } from "./sampleRecord.js";
import { samples } from "./samples.js";

const TEST_SECRET = "whsec_test_secret_for_roundtrip_only";

function configForPreset(presetId: WebhookPresetId): WebhookVerifierConfig | null {
  switch (presetId) {
    case "stripe":
      return stripeVerifierConfig();
    case "github":
      return githubVerifierConfig();
    case "svix":
      return svixVerifierConfig();
    case "square":
      return squareVerifierConfig();
    case "discord":
      return discordVerifierConfig();
    case "custom":
      return null;
  }
}

describe("webhook-sources schema", () => {
  it("every bundled sample matches the SampleRecord schema", () => {
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      SampleRecord.parse(sample);
    }
  });
});

function configForSample(sample: SampleRecordType): WebhookVerifierConfig | null {
  const provider = webhookProviderConfigs[sample.provider as keyof typeof webhookProviderConfigs];
  if (provider) return provider.config();
  if (sample.presetId) return configForPreset(sample.presetId);
  return null;
}

describe("verifier round-trip (sign -> verify)", () => {
  const verifiableSamples = samples.filter(
    (sample) => sample.presetId || sample.provider in webhookProviderConfigs
  );

  it("has verifiable samples to check", () => {
    expect(verifiableSamples.length).toBeGreaterThan(0);
  });

  for (const sample of verifiableSamples) {
    it(`${sample.provider} / ${sample.eventType} signs and verifies under its config`, () => {
      const config = configForSample(sample);
      if (!config) return;

      const rawBody = new TextEncoder().encode(JSON.stringify(sample.body));
      const url = "https://example.com/webhooks/v1/ingest/op_roundtrip";

      const signed = signWithVerifierConfig({
        config,
        secret: TEST_SECRET,
        rawBody,
        url,
        headers: { ...(sample.extraHeaders ?? {}) },
      });

      if (!signed.ok) {
        expect(signed.notSignable).toBe(true);
        return;
      }

      const verdict = verify(
        { kind: "config", config },
        {
          rawBytes: signed.body,
          headers: signed.headers,
          url: signed.url,
          secret: TEST_SECRET,
        }
      );

      expect(verdict.ok).toBe(true);
    });
  }
});
