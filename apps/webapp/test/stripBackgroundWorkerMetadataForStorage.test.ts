import { BackgroundWorkerMetadata } from "@trigger.dev/core/v3";
import { describe, expect, it } from "vitest";
import { stripBackgroundWorkerMetadataForStorage } from "~/v3/services/stripBackgroundWorkerMetadataForStorage.server";

const baseMetadata: BackgroundWorkerMetadata = {
  packageVersion: "4.8.1",
  contentHash: "hash",
  tasks: [
    { id: "plain", filePath: "src/trigger/plain.ts", exportName: "plain" },
    {
      id: "nightly",
      filePath: "src/trigger/nightly.ts",
      exportName: "nightly",
      schedule: { cron: "0 0 * * *", timezone: "UTC" },
    },
  ],
};

function roundTrip(metadata: BackgroundWorkerMetadata) {
  const stored = JSON.parse(JSON.stringify(stripBackgroundWorkerMetadataForStorage(metadata)));
  return BackgroundWorkerMetadata.parse(stored);
}

describe("stripBackgroundWorkerMetadataForStorage", () => {
  it("keeps only scheduled tasks", () => {
    const parsed = roundTrip(baseMetadata);

    expect(parsed.tasks.map((t) => t.id)).toEqual(["nightly"]);
    expect(parsed.tasks[0].schedule).toEqual({ cron: "0 0 * * *", timezone: "UTC" });
  });

  it("keeps webhook endpoints and subscribers so promotion can re-sync them", () => {
    const webhookEndpoints: BackgroundWorkerMetadata["webhookEndpoints"] = [
      {
        id: "stripe-events",
        filePath: "src/trigger/stripe.ts",
        source: "stripe",
        verifierArtifact: { kind: "bundle", bundleUrl: "https://example.test/v.js", hash: "h" },
      },
    ];
    const webhookSubscribers: BackgroundWorkerMetadata["webhookSubscribers"] = [
      {
        endpointId: "stripe-events",
        target: { type: "task", id: "plain", taskId: "plain" },
      },
    ];

    const parsed = roundTrip({ ...baseMetadata, webhookEndpoints, webhookSubscribers });

    expect(parsed.webhookEndpoints).toEqual(webhookEndpoints);
    expect(parsed.webhookSubscribers).toEqual(webhookSubscribers);
  });

  it("keeps an empty endpoint list so promotion removes endpoints the worker no longer declares", () => {
    const parsed = roundTrip({ ...baseMetadata, webhookEndpoints: [], webhookSubscribers: [] });

    expect(parsed.webhookEndpoints).toEqual([]);
    expect(parsed.webhookSubscribers).toEqual([]);
  });

  it("leaves webhook fields absent when the worker didn't declare them", () => {
    const parsed = roundTrip(baseMetadata);

    expect(parsed.webhookEndpoints).toBeUndefined();
    expect(parsed.webhookSubscribers).toBeUndefined();
  });
});
