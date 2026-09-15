import type { WebhookDatabase } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { WebhookEngine } from "./index.js";
import type { TriggerWebhookTaskCallback } from "./types.js";

const triggerTask: TriggerWebhookTaskCallback = async () => ({ success: true });

function buildDisabledEngine() {
  return new WebhookEngine({
    prisma: {} as unknown as WebhookDatabase,
    disabled: true,
    redis: { host: "127.0.0.1", port: 6379 },
    worker: { concurrency: 1 },
    triggerTask,
    resolveSigningSecret: async () => undefined,
    logLevel: "error",
  });
}

describe("WebhookEngine (disabled)", () => {
  it("skips Redis and worker setup, and rejects public calls", async () => {
    const engine = buildDisabledEngine();

    await expect(
      engine.ingest({
        opaqueId: "x",
        rawBytes: new TextEncoder().encode("{}"),
        headers: {},
        url: "https://example.com/webhooks/v1/ingest/x",
      })
    ).rejects.toThrow(/disabled/i);

    await expect(engine.getJob("job")).rejects.toThrow(/disabled/i);

    await expect(engine.quit()).resolves.toBeUndefined();
  });
});
