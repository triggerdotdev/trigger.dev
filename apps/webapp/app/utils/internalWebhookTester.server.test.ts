import { createHmac } from "node:crypto";
import { Logger } from "@trigger.dev/core/logger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleInternalWebhookTest } from "./internalWebhookTester.server";

const webhookSecret = "test-internal-webhook-secret";
const logger = new Logger("internal-webhook-test", "info");
const logs: Record<string, unknown>[] = [];
let restoreLogSink: () => void;

describe("internal webhook tester", () => {
  beforeEach(() => {
    logs.length = 0;
    const originalOnLog = Logger.onLog;
    Logger.onLog = (log) => logs.push(log);
    restoreLogSink = () => {
      Logger.onLog = originalOnLog;
    };
  });

  afterEach(() => {
    restoreLogSink();
  });

  it.each(["POST", "PUT"])(
    "rejects production %s requests without touching the body",
    async (method) => {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode("untrusted webhook body"));
            controller.close();
          },
        },
        { highWaterMark: 0 }
      );
      const request = new Request("http://localhost/internal/webhooks/tester", {
        method,
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      const response = await handleInternalWebhookTest(request, {
        nodeEnv: "production",
        webhookSecret,
        logger,
      });

      expect(response.status).toBe(404);
      expect(pulls).toBe(0);
      expect(request.bodyUsed).toBe(false);
      expect(body.locked).toBe(false);
      expect(logs).toEqual([]);
      await body.cancel();
    }
  );

  it.each([undefined, "0".repeat(64)])(
    "does not log raw content with signature %s",
    async (signature) => {
      const rawBody = "attacker-controlled-content\nforged log entry";
      const request = new Request("http://localhost/internal/webhooks/tester", {
        method: "POST",
        body: rawBody,
        headers: signature ? { "x-trigger-signature-hmacsha256": signature } : {},
      });

      const response = await handleInternalWebhookTest(request, {
        nodeEnv: "test",
        webhookSecret,
        logger,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: signature ? "Invalid signature" : "No signature header found",
      });
      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain("attacker-controlled-content");
      expect(JSON.stringify(logs)).not.toContain("forged log entry");
      expect(logs[0]).not.toHaveProperty("rawBody");
      expect(request.bodyUsed).toBe(Boolean(signature));
    }
  );

  it.each(["test", "development"])(
    "accepts signed requests in %s with only event-type logs",
    async (nodeEnv) => {
      const rawBody = JSON.stringify({
        id: "webhook_test",
        created: "2026-01-01T00:00:00.000Z",
        webhookVersion: "1",
        type: "alert.deployment.success",
        object: {
          environment: { id: "env_test", type: "DEVELOPMENT", slug: "dev" },
          organization: { id: "org_test", slug: "test", name: "private-webhook-content" },
          project: { id: "proj_test", ref: "test", slug: "test", name: "test" },
          deployment: {
            id: "deploy_test",
            status: "DEPLOYED",
            version: "1",
            shortCode: "test",
            deployedAt: "2026-01-01T00:00:00.000Z",
          },
          tasks: [],
        },
      });
      const signature = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
      const request = new Request("http://localhost/internal/webhooks/tester", {
        method: "POST",
        body: rawBody,
        headers: { "x-trigger-signature-hmacsha256": signature },
      });

      const response = await handleInternalWebhookTest(request, { nodeEnv, webhookSecret, logger });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });
      expect(request.bodyUsed).toBe(true);
      expect(logs).toHaveLength(2);
      expect(logs[0]).toMatchObject({ type: "alert.deployment.success" });
      expect(logs[0]).not.toHaveProperty("object");
      expect(logs[0]).not.toHaveProperty("rawBody");
      expect(JSON.stringify(logs)).not.toContain("private-webhook-content");
    }
  );
});
