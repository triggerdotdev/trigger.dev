import { webhookProviderConfigs } from "@trigger.dev/core/webhooks";
import { describe, expect, it } from "vitest";
import { samples } from "./samples.js";

function readPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]),
      value
    );
}

const bodyFields = Object.entries(webhookProviderConfigs).flatMap(([provider, preset]) => {
  const field = preset.config().idempotencyField;
  return field?.from === "body" ? [{ provider, path: field.name }] : [];
});

describe("provider idempotency fields", () => {
  it("has providers that dedupe on a body field", () => {
    expect(bodyFields.length).toBeGreaterThan(0);
  });

  for (const { provider, path } of bodyFields) {
    const providerSamples = samples.filter((sample) => sample.provider === provider);

    it.skipIf(providerSamples.length === 0)(
      `every ${provider} sample has a string ${path} to dedupe on`,
      () => {
        for (const sample of providerSamples) {
          const value = readPath(sample.body, path);
          expect(typeof value, `${sample.name}: ${path}`).toBe("string");
          expect((value as string).length, `${sample.name}: ${path}`).toBeGreaterThan(0);
        }
      }
    );
  }
});
