import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { containerTestWithIsolatedRedisNoClickhouse } from "@internal/testcontainers";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { WebhookEndpointId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { WebhookEngine } from "./index.js";
import type { TriggerWebhookTaskCallback } from "./types.js";

const SECRET = "whsec_fairness_secret";
const SECRET_KEY = "secretref_fairness";

const VERIFIER_CONFIG = {
  scheme: "hmac",
  algorithm: "sha256",
  encoding: "hex",
  signatureHeader: "stripe-signature",
  signature: { itemSeparator: ",", fieldSeparator: "=", field: "v1" },
  timestamp: { source: { from: "signatureField", field: "t" }, toleranceSeconds: 300 },
  signingString: { template: "{timestamp}.{body}" },
  idempotencyField: { from: "body", name: "id" },
} as const;

async function createEndpoint(prisma: PrismaClient, environmentId: string) {
  return prisma.webhookEndpoint.create({
    data: {
      friendlyId: WebhookEndpointId.generate().friendlyId,
      opaqueId: `op_${randomBytes(12).toString("hex")}`,
      organizationId: `org_${environmentId}`,
      projectId: `proj_${environmentId}`,
      runtimeEnvironmentId: environmentId,
      environmentType: "PRODUCTION",
      source: "stripe",
      declaredId: "payments",
      routingTargets: [
        { type: "task", id: "orders", taskId: "orders" },
      ] as unknown as Prisma.InputJsonValue,
      verifierArtifact: { kind: "config", config: VERIFIER_CONFIG },
      signingSecretKey: SECRET_KEY,
      status: "ACTIVE",
    },
  });
}

function signed(opaqueId: string) {
  const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: "payment_intent.succeeded" });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return {
    opaqueId,
    rawBytes: new TextEncoder().encode(body),
    headers: { "stripe-signature": `t=${t},v1=${sig}` },
    url: `https://api.example.com/webhooks/v1/ingest/${opaqueId}`,
  };
}

containerTestWithIsolatedRedisNoClickhouse(
  "one environment's flood of deliveries can't hold more than its share of the worker",
  async ({ prisma, redisOptions }) => {
    const noisy = await createEndpoint(prisma, "env_noisy");
    const quiet = await createEndpoint(prisma, "env_quiet");

    const inFlight = new Map<string, number>();
    const peak = new Map<string, number>();
    const finished: string[] = [];
    const triggerTask: TriggerWebhookTaskCallback = async ({ environmentId }) => {
      const now = (inFlight.get(environmentId) ?? 0) + 1;
      inFlight.set(environmentId, now);
      peak.set(environmentId, Math.max(peak.get(environmentId) ?? 0, now));
      await new Promise((resolve) => setTimeout(resolve, 150));
      inFlight.set(environmentId, (inFlight.get(environmentId) ?? 1) - 1);
      finished.push(environmentId);
      return { success: true, runId: `run_${randomUUID()}` };
    };

    const engine = new WebhookEngine({
      prisma,
      redis: redisOptions,
      worker: {
        concurrency: 6,
        tenantConcurrency: async (environmentId) => (environmentId === "env_noisy" ? 2 : 4),
        pollIntervalMs: 20,
      },
      endpointCache: { ttlMs: 0 },
      triggerTask,
      resolveSigningSecret: async (key) => (key === SECRET_KEY ? SECRET : undefined),
      logLevel: "error",
    });

    try {
      for (let i = 0; i < 20; i++) {
        const result = await engine.ingest(signed(noisy.opaqueId));
        expect(result.outcome).toBe("accepted");
      }
      const quietResult = await engine.ingest(signed(quiet.opaqueId));
      expect(quietResult.outcome).toBe("accepted");

      const deadline = Date.now() + 30_000;
      while (finished.length < 21 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(finished).toHaveLength(21);
      expect(peak.get("env_noisy")).toBeLessThanOrEqual(2);
      expect(finished.indexOf("env_quiet")).toBeLessThan(6);
    } finally {
      await engine.quit();
    }
  },
  60_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a process with its worker disabled only enqueues, and a separate worker process runs the jobs",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma, "env_split");
    const triggered: string[] = [];
    const common = {
      prisma,
      redis: redisOptions,
      endpointCache: { ttlMs: 0 },
      resolveSigningSecret: async (key: string) => (key === SECRET_KEY ? SECRET : undefined),
      logLevel: "error" as const,
    };
    const ingress = new WebhookEngine({
      ...common,
      worker: { concurrency: 2, pollIntervalMs: 20, disabled: true },
      triggerTask: async () => {
        throw new Error("the ingress process must not run delivery jobs");
      },
    });

    let worker: WebhookEngine | undefined;
    try {
      const result = await ingress.ingest(signed(endpoint.opaqueId));
      if (result.outcome !== "accepted") throw new Error(`ingest ${result.outcome}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await ingress.isDeliveryQueued(result.deliveryId)).toBe(true);

      worker = new WebhookEngine({
        ...common,
        worker: { concurrency: 2, pollIntervalMs: 20 },
        triggerTask: async ({ environmentId }) => {
          triggered.push(environmentId);
          return { success: true, runId: `run_${randomUUID()}` };
        },
      });
      const deadline = Date.now() + 15_000;
      while (triggered.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(triggered).toEqual(["env_split"]);
      const delivery = await prisma.webhookDelivery.findFirst({ where: { id: result.deliveryId } });
      expect(delivery?.status).toBe("SUCCEEDED");
    } finally {
      await ingress.quit();
      await worker?.quit();
    }
  },
  30_000
);
