import { createHmac, randomBytes } from "node:crypto";
import {
  containerTestWithIsolatedRedisNoClickhouse,
  createStandalonePostgresContainer,
} from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { type Prisma, PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "@internal/redis";
import { WebhookEndpointId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { WebhookEngine } from "./index.js";
import { parseFilter } from "./filter/index.js";
import type {
  DeliverWebhookToSessionCallback,
  DeliverWebhookToSessionParams,
  TriggerWebhookTaskCallback,
  TriggerWebhookTaskParams,
} from "./types.js";

// End-to-end ingest -> deliver over a real Postgres + Redis: the de-risking test for the atomic
// front gate (happy path, concurrent dedup, crash recovery) and the Run-Engine idempotencyKey wiring.

const SECRET = "whsec_integration_secret";
const SECRET_KEY = "secretref_integration";

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

// Live clock so the 300s tolerance passes (the engine calls verify() without an injected clock).
function signedInput(eventId: string, opaqueId: string, type = "payment_intent.succeeded") {
  const body = JSON.stringify({ id: eventId, type });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return {
    opaqueId,
    rawBytes: new TextEncoder().encode(body),
    headers: { "stripe-signature": `t=${t},v1=${sig}` },
    url: `https://api.example.com/webhooks/v1/ingest/${opaqueId}`,
  };
}

async function createEndpoint(prisma: PrismaClient, over?: { filter?: string }) {
  return prisma.webhookEndpoint.create({
    data: {
      friendlyId: WebhookEndpointId.generate().friendlyId,
      opaqueId: `op_${randomBytes(12).toString("hex")}`,
      organizationId: "org_test",
      projectId: "proj_test",
      runtimeEnvironmentId: "env_test",
      environmentType: "PRODUCTION",
      source: "stripe",
      handlerWebhookId: "handle-stripe-webhook",
      routingTarget: { type: "task", taskId: "handle-stripe-task" },
      verifierArtifact: { kind: "config", config: VERIFIER_CONFIG },
      signingSecretKey: SECRET_KEY,
      status: "ACTIVE",
      ...(over?.filter
        ? {
            filter: over.filter,
            filterAst: parseFilter(over.filter) as unknown as Prisma.InputJsonValue,
            filterAstVersion: 1,
          }
        : {}),
    },
  });
}

// Models Run-Engine idempotency: same idempotencyKey -> same run, so distinct runs = runsByKey.size.
function makeTriggerTaskStub() {
  const calls: TriggerWebhookTaskParams[] = [];
  const runsByKey = new Map<string, string>();
  let runCounter = 0;
  const triggerTask: TriggerWebhookTaskCallback = async (params) => {
    calls.push(params);
    let runId = runsByKey.get(params.idempotencyKey);
    if (!runId) {
      runId = `run_${++runCounter}`;
      runsByKey.set(params.idempotencyKey, runId);
    }
    return { success: true, runId };
  };
  return { triggerTask, calls, runsByKey };
}

// Session-routing endpoint: routes to a find-or-created session (keyTemplate -> externalId) instead
// of a task. The stub stands in for the webapp's deliverToSession port (find-or-create + append).
async function createSessionEndpoint(
  prisma: PrismaClient,
  keyTemplate: string,
  startOn?: string,
  handlerWebhookId = "agent-x:orders"
) {
  return prisma.webhookEndpoint.create({
    data: {
      friendlyId: WebhookEndpointId.generate().friendlyId,
      opaqueId: `op_${randomBytes(12).toString("hex")}`,
      organizationId: "org_test",
      projectId: "proj_test",
      runtimeEnvironmentId: "env_test",
      environmentType: "PRODUCTION",
      source: "stripe",
      handlerWebhookId,
      routingTarget: {
        type: "session",
        taskIdentifier: "agent-x",
        keyTemplate,
        actionType: "order.event",
        deliverAs: "action",
        ...(startOn ? { startOn } : {}),
      },
      verifierArtifact: { kind: "config", config: VERIFIER_CONFIG },
      signingSecretKey: SECRET_KEY,
      status: "ACTIVE",
    },
  });
}

function makeDeliverToSessionStub() {
  const calls: DeliverWebhookToSessionParams[] = [];
  const runsByExternalId = new Map<string, string>();
  let runCounter = 0;
  const deliverToSession: DeliverWebhookToSessionCallback = async (params) => {
    calls.push(params);
    let runId = runsByExternalId.get(params.externalId);
    if (!runId) {
      runId = `srun_${++runCounter}`;
      runsByExternalId.set(params.externalId, runId);
    }
    return { success: true, runId };
  };
  return { deliverToSession, calls, runsByExternalId };
}

function buildEngine(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  triggerTask: TriggerWebhookTaskCallback,
  over?: {
    claimTtlSeconds?: number;
    workerDisabled?: boolean;
    endpointCacheTtlMs?: number;
    resolveSigningSecret?: (key: string) => Promise<string | undefined>;
    deliverToSession?: DeliverWebhookToSessionCallback;
  }
) {
  return new WebhookEngine({
    prisma,
    redis: redisOptions,
    worker: { concurrency: 1, pollIntervalMs: 50, disabled: over?.workerDisabled },
    frontGate: over?.claimTtlSeconds ? { claimTtlSeconds: over.claimTtlSeconds } : undefined,
    endpointCache:
      over?.endpointCacheTtlMs !== undefined ? { ttlMs: over.endpointCacheTtlMs } : undefined,
    triggerTask,
    deliverToSession: over?.deliverToSession,
    resolveSigningSecret:
      over?.resolveSigningSecret ?? (async (key) => (key === SECRET_KEY ? SECRET : undefined)),
    logLevel: "error",
  });
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

containerTestWithIsolatedRedisNoClickhouse(
  "ingest -> deliver routes a verified event to exactly one run",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const { triggerTask, calls, runsByKey } = makeTriggerTaskStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask);

    try {
      const eventId = "evt_happy_1";
      const result = await engine.ingest(signedInput(eventId, endpoint.opaqueId));

      expect(result.outcome).toBe("accepted");
      if (result.outcome !== "accepted") return;
      const deliveryId = result.deliveryId;

      await waitFor(async () => {
        const d = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId } });
        return d?.status === "SUCCEEDED";
      });

      const delivery = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId } });
      expect(delivery?.runId).toBe("run_1");
      expect(delivery?.externalDeliveryId).toBe(eventId);

      expect(calls).toHaveLength(1);
      expect(runsByKey.size).toBe(1);
      expect(calls[0].taskId).toBe("handle-stripe-task");
      expect(calls[0].idempotencyKey).toBe(`${endpoint.id}:${eventId}`);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "ingest -> deliver routes the full event when it exceeds the dashboard snapshot cap",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const { triggerTask, calls } = makeTriggerTaskStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask);

    try {
      const eventId = "evt_large_1";
      const blob = "x".repeat(64 * 1024);
      const body = JSON.stringify({ id: eventId, type: "payment_intent.succeeded", blob });
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");

      const result = await engine.ingest({
        opaqueId: endpoint.opaqueId,
        rawBytes: new TextEncoder().encode(body),
        headers: { "stripe-signature": `t=${t},v1=${sig}` },
        url: `https://api.example.com/webhooks/v1/ingest/${endpoint.opaqueId}`,
      });

      expect(result.outcome).toBe("accepted");
      if (result.outcome !== "accepted") return;
      const deliveryId = result.deliveryId;

      await waitFor(async () => {
        const d = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId } });
        return d?.status === "SUCCEEDED";
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].payload).toEqual({ id: eventId, type: "payment_intent.succeeded", blob });

      const delivery = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId } });
      const stored = delivery?.parsedEvent as { blob?: string; truncated?: boolean } | null;
      expect(stored?.blob).toBe(blob);
      expect(stored?.truncated).toBeUndefined();
    } finally {
      await engine.quit();
    }
  }
);

// Two-database mode: point the engine at a SEPARATE Postgres (the future data-plane DB) with the
// fixture's `prisma` as the main DB, and prove webhook writes land only on the injected client (a
// leaked query onto the main client would show up as a row there). Runtime backstop to the types.
containerTestWithIsolatedRedisNoClickhouse(
  "two-database mode: webhook writes land on the injected client's DB, never the main DB",
  async ({ prisma, redisOptions }) => {
    const { container: webhookContainer, url: webhookUrl } =
      await createStandalonePostgresContainer();
    const webhookDb = new PrismaClient({ datasources: { db: { url: webhookUrl } } });
    const { triggerTask } = makeTriggerTaskStub();
    const engine = buildEngine(webhookDb, redisOptions, triggerTask);

    try {
      // The endpoint lives on the webhook DB; the engine reads it from its own client.
      const endpoint = await createEndpoint(webhookDb);

      const eventId = "evt_two_db_1";
      const result = await engine.ingest(signedInput(eventId, endpoint.opaqueId));
      expect(result.outcome).toBe("accepted");
      if (result.outcome !== "accepted") return;

      await waitFor(async () => {
        const d = await webhookDb.webhookDelivery.findFirst({ where: { id: result.deliveryId } });
        return d?.status === "SUCCEEDED";
      });

      // The delivery + endpoint are on the webhook DB...
      expect(await webhookDb.webhookDelivery.count()).toBe(1);
      expect(await webhookDb.webhookEndpoint.count()).toBe(1);

      // ...and nothing leaked onto the main DB.
      expect(await prisma.webhookDelivery.count()).toBe(0);
      expect(await prisma.webhookEndpoint.count()).toBe(0);
    } finally {
      await engine.quit();
      await webhookDb.$disconnect();
      await webhookContainer.stop();
    }
  },
  120_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a provider handshake (url_verification) echoes the challenge and records no delivery",
  async ({ prisma, redisOptions }) => {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        friendlyId: WebhookEndpointId.generate().friendlyId,
        opaqueId: `op_${randomBytes(12).toString("hex")}`,
        organizationId: "org_test",
        projectId: "proj_test",
        runtimeEnvironmentId: "env_test",
        environmentType: "PRODUCTION",
        source: "slack",
        handlerWebhookId: "handle-slack-channel",
        routingTarget: { type: "task", taskId: "unused" },
        verifierArtifact: {
          kind: "config",
          config: VERIFIER_CONFIG,
          handshake: {
            matchPath: "type",
            matchValue: "url_verification",
            respondPath: "challenge",
          },
        },
        signingSecretKey: SECRET_KEY,
        status: "ACTIVE",
      },
    });
    const { triggerTask } = makeTriggerTaskStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask);

    try {
      const body = JSON.stringify({ type: "url_verification", challenge: "chal_xyz" });
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
      const result = await engine.ingest({
        opaqueId: endpoint.opaqueId,
        rawBytes: new TextEncoder().encode(body),
        headers: { "stripe-signature": `t=${t},v1=${sig}` },
        url: `https://api.example.com/webhooks/v1/ingest/${endpoint.opaqueId}`,
      });

      expect(result.outcome).toBe("handshake");
      if (result.outcome === "handshake") expect(result.body).toBe("chal_xyz");

      const count = await prisma.webhookDelivery.count({
        where: { webhookEndpointId: endpoint.id },
      });
      expect(count).toBe(0);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "concurrent duplicate deliveries collapse to one delivery row and one run",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const { triggerTask, calls, runsByKey } = makeTriggerTaskStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask);

    try {
      const eventId = "evt_dupe_1";
      const input = signedInput(eventId, endpoint.opaqueId);

      const [a, b] = await Promise.all([engine.ingest(input), engine.ingest(input)]);

      // The atomic SET NX claim guarantees exactly one accepted and one duplicate.
      expect([a.outcome, b.outcome].sort()).toEqual(["accepted", "duplicate"]);

      const accepted = (a.outcome === "accepted" ? a : b) as Extract<
        typeof a,
        { outcome: "accepted" }
      >;
      const duplicate = (a.outcome === "duplicate" ? a : b) as Extract<
        typeof a,
        { outcome: "duplicate" }
      >;
      expect(duplicate.deliveryId).toBe(accepted.deliveryFriendlyId);

      const rows = await prisma.webhookDelivery.findMany({
        where: { webhookEndpointId: endpoint.id },
      });
      expect(rows).toHaveLength(1);

      await waitFor(async () => {
        const d = await prisma.webhookDelivery.findFirst({ where: { id: accepted.deliveryId } });
        return d?.status === "SUCCEEDED";
      });

      expect(calls).toHaveLength(1);
      expect(runsByKey.size).toBe(1);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "stores curated, size-bounded headers (drops credentials and oversized headers)",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const { triggerTask } = makeTriggerTaskStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask, { workerDisabled: true });

    try {
      const input = signedInput("evt_headers_1", endpoint.opaqueId);
      input.headers["authorization"] = "Bearer super-secret";
      input.headers["cookie"] = "session=abc";
      input.headers["x-custom"] = "keep-me";
      input.headers["x-huge"] = "z".repeat(8 * 1024);

      const result = await engine.ingest(input);
      expect(result.outcome).toBe("accepted");
      if (result.outcome !== "accepted") return;

      const delivery = await prisma.webhookDelivery.findFirst({ where: { id: result.deliveryId } });
      const stored = delivery!.headers as Record<string, string>;

      expect(stored["authorization"]).toBeUndefined();
      expect(stored["cookie"]).toBeUndefined();
      expect(stored["x-huge"]).toBeUndefined();
      expect(stored["x-custom"]).toBe("keep-me");
      expect(stored["stripe-signature"]).toBeDefined();
      expect(JSON.stringify(stored).length).toBeLessThanOrEqual(4 * 1024 + 256);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "caches the endpoint + secret across ingests and re-reads after the TTL",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const { triggerTask } = makeTriggerTaskStub();
    let secretReads = 0;
    const engine = buildEngine(prisma, redisOptions, triggerTask, {
      endpointCacheTtlMs: 200,
      resolveSigningSecret: async (key) => {
        secretReads++;
        return key === SECRET_KEY ? SECRET : undefined;
      },
    });

    try {
      expect((await engine.ingest(signedInput("evt_cache_1", endpoint.opaqueId))).outcome).toBe(
        "accepted"
      );
      expect((await engine.ingest(signedInput("evt_cache_2", endpoint.opaqueId))).outcome).toBe(
        "accepted"
      );
      // Second ingest hit the cache, so the secret was resolved only once.
      expect(secretReads).toBe(1);

      // After the TTL the entry expires and the next ingest re-resolves.
      await new Promise((r) => setTimeout(r, 250));
      expect((await engine.ingest(signedInput("evt_cache_3", endpoint.opaqueId))).outcome).toBe(
        "accepted"
      );
      expect(secretReads).toBe(2);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a crash between claim and promote releases the short lock so the event is re-processed",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const { triggerTask } = makeTriggerTaskStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask, {
      claimTtlSeconds: 1,
      workerDisabled: true,
    });
    const gate = createRedisClient(redisOptions);

    try {
      const eventId = "evt_crash_1";
      const input = signedInput(eventId, endpoint.opaqueId);
      const gateKey = `webhookdedupe:${endpoint.id}:${eventId}`;

      // Post-crash state: claim set (short TTL), but the ingest died before creating the row.
      await gate.set(gateKey, "whd_orphaned_claim", "EX", 1, "NX");

      const blocked = await engine.ingest(input);
      expect(blocked.outcome).toBe("duplicate");
      expect(
        await prisma.webhookDelivery.count({ where: { webhookEndpointId: endpoint.id } })
      ).toBe(0);

      // Once the short lock expires, a retry re-claims and the event is processed, not dropped.
      await waitFor(async () => (await gate.get(gateKey)) === null, 5_000);

      const recovered = await engine.ingest(input);
      expect(recovered.outcome).toBe("accepted");
      expect(
        await prisma.webhookDelivery.count({ where: { webhookEndpointId: endpoint.id } })
      ).toBe(1);
    } finally {
      await gate.quit();
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "filter gate: a non-matching event is recorded FILTERED and not routed; a match is routed",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma, {
      filter: "event.type == 'payment_intent.succeeded'",
    });
    const { triggerTask, calls } = makeTriggerTaskStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask);

    try {
      // Matching event -> routed to a run as usual.
      const match = await engine.ingest(signedInput("evt_match", endpoint.opaqueId));
      expect(match.outcome).toBe("accepted");
      if (match.outcome !== "accepted") return;
      await waitFor(async () => {
        const d = await prisma.webhookDelivery.findFirst({ where: { id: match.deliveryId } });
        return d?.status === "SUCCEEDED";
      });
      expect(calls).toHaveLength(1);

      // Non-matching event -> still received (200 + row), recorded FILTERED, never routed.
      const filtered = await engine.ingest(
        signedInput("evt_nomatch", endpoint.opaqueId, "payment_intent.failed")
      );
      expect(filtered.outcome).toBe("accepted");
      if (filtered.outcome !== "accepted") return;

      const row = await prisma.webhookDelivery.findFirst({ where: { id: filtered.deliveryId } });
      expect(row?.status).toBe("FILTERED");
      expect(row?.runId).toBeNull();
      expect(row?.filterReason).toContain("event.type");

      // The deliver worker must never pick it up: no new triggerTask call after a beat.
      await new Promise((r) => setTimeout(r, 300));
      expect(calls).toHaveLength(1);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "session routing resolves the key and delivers to the session port",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSessionEndpoint(prisma, "{body.id}");
    const { triggerTask } = makeTriggerTaskStub();
    const { deliverToSession, calls } = makeDeliverToSessionStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask, { deliverToSession });

    try {
      const eventId = "evt_sess_1";
      const result = await engine.ingest(signedInput(eventId, endpoint.opaqueId));
      if (result.outcome !== "accepted")
        throw new Error(`expected accepted, got ${result.outcome}`);

      await waitFor(async () => {
        const d = await prisma.webhookDelivery.findFirst({ where: { id: result.deliveryId } });
        return d?.status === "SUCCEEDED";
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.externalId).toBe(eventId); // {body.id} -> event id
      expect(calls[0]?.taskIdentifier).toBe("agent-x");
      expect(calls[0]?.actionType).toBe("order.event");
      expect((calls[0]!.event as { id: string }).id).toBe(eventId);
      expect(calls[0]?.deliveryId).toBe(eventId);

      const d = await prisma.webhookDelivery.findFirst({ where: { id: result.deliveryId } });
      expect(d?.runId).toBe("srun_1"); // the session's run, from the port
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "session delivery with an unresolvable key is FAILED and never calls the port",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSessionEndpoint(prisma, "{body.customerId}"); // not in the body
    const { triggerTask } = makeTriggerTaskStub();
    const { deliverToSession, calls } = makeDeliverToSessionStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask, { deliverToSession });

    try {
      const result = await engine.ingest(signedInput("evt_sess_nokey", endpoint.opaqueId));
      if (result.outcome !== "accepted")
        throw new Error(`expected accepted, got ${result.outcome}`);

      await waitFor(async () => {
        const d = await prisma.webhookDelivery.findFirst({ where: { id: result.deliveryId } });
        return d?.status === "FAILED";
      });

      expect(calls).toHaveLength(0);
      const d = await prisma.webhookDelivery.findFirst({ where: { id: result.deliveryId } });
      expect(d?.errorMessage).toContain("key resolved empty");
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "startOn is evaluated and passed to the port as isSessionStart (default true when absent)",
  async ({ prisma, redisOptions }) => {
    const gated = await createSessionEndpoint(prisma, "{body.id}", "event.type == 'session.start'");
    const open = await createSessionEndpoint(prisma, "{body.id}", undefined, "agent-y:orders"); // no startOn
    const { triggerTask } = makeTriggerTaskStub();
    const { deliverToSession, calls } = makeDeliverToSessionStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask, { deliverToSession });

    try {
      const rStart = await engine.ingest(signedInput("evt_start", gated.opaqueId, "session.start"));
      const rOther = await engine.ingest(signedInput("evt_other", gated.opaqueId, "message"));
      const rOpen = await engine.ingest(signedInput("evt_open", open.opaqueId, "message"));
      for (const r of [rStart, rOther, rOpen]) {
        if (r.outcome !== "accepted") throw new Error(`expected accepted, got ${r.outcome}`);
      }

      await waitFor(async () => calls.length === 3);
      const byId = (id: string) => calls.find((c) => (c.event as { id: string }).id === id);
      expect(byId("evt_start")?.isSessionStart).toBe(true); // matches startOn
      expect(byId("evt_other")?.isSessionStart).toBe(false); // does not match startOn
      expect(byId("evt_open")?.isSessionStart).toBe(true); // no startOn -> default true
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a skipped session result is recorded FILTERED with the reason and no run",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSessionEndpoint(
      prisma,
      "{body.id}",
      "event.type == 'session.start'"
    );
    const { triggerTask } = makeTriggerTaskStub();
    // Stand in for the webapp: resume-only (no session yet) + not a start event -> skipped.
    const calls: DeliverWebhookToSessionParams[] = [];
    const deliverToSession: DeliverWebhookToSessionCallback = async (params) => {
      calls.push(params);
      if (!params.isSessionStart) {
        return {
          success: true,
          skipped: true,
          skippedReason: "startOn: not a session-start event",
        };
      }
      return { success: true, runId: "srun_start" };
    };
    const engine = buildEngine(prisma, redisOptions, triggerTask, { deliverToSession });

    try {
      const skip = await engine.ingest(signedInput("evt_skip", endpoint.opaqueId, "message"));
      const start = await engine.ingest(signedInput("evt_go", endpoint.opaqueId, "session.start"));
      if (skip.outcome !== "accepted" || start.outcome !== "accepted")
        throw new Error("expected accepted");

      await waitFor(async () => {
        const a = await prisma.webhookDelivery.findFirst({ where: { id: skip.deliveryId } });
        const b = await prisma.webhookDelivery.findFirst({ where: { id: start.deliveryId } });
        return a?.status === "FILTERED" && b?.status === "SUCCEEDED";
      });

      const skipped = await prisma.webhookDelivery.findFirst({ where: { id: skip.deliveryId } });
      expect(skipped?.status).toBe("FILTERED");
      expect(skipped?.filterReason).toContain("startOn");
      expect(skipped?.runId).toBeNull();

      const started = await prisma.webhookDelivery.findFirst({ where: { id: start.deliveryId } });
      expect(started?.runId).toBe("srun_start");
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "session delivery fails when the deliverToSession port is not configured",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSessionEndpoint(prisma, "{body.id}");
    const { triggerTask } = makeTriggerTaskStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask); // no deliverToSession port

    try {
      const result = await engine.ingest(signedInput("evt_sess_noport", endpoint.opaqueId));
      if (result.outcome !== "accepted")
        throw new Error(`expected accepted, got ${result.outcome}`);

      await waitFor(async () => {
        const d = await prisma.webhookDelivery.findFirst({ where: { id: result.deliveryId } });
        return d?.status === "FAILED";
      });

      const d = await prisma.webhookDelivery.findFirst({ where: { id: result.deliveryId } });
      expect(d?.errorMessage).toContain("not configured");
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a delivery whose port keeps failing transiently is FAILED after max attempts (not stuck PENDING)",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    let calls = 0;
    const triggerTask: TriggerWebhookTaskCallback = async () => {
      calls++;
      return { success: false, errorType: "SYSTEM_ERROR", error: "boom" };
    };
    const engine = buildEngine(prisma, redisOptions, triggerTask);

    try {
      const result = await engine.ingest(signedInput("evt_exhaust", endpoint.opaqueId));
      if (result.outcome !== "accepted")
        throw new Error(`expected accepted, got ${result.outcome}`);

      // 5 attempts with backoff (~1+2+4+8s), then the final attempt marks FAILED instead of PENDING.
      await waitFor(async () => {
        const d = await prisma.webhookDelivery.findFirst({ where: { id: result.deliveryId } });
        return d?.status === "FAILED";
      }, 40_000);

      const d = await prisma.webhookDelivery.findFirst({ where: { id: result.deliveryId } });
      expect(d?.status).toBe("FAILED");
      expect(d?.errorMessage).toContain("boom");
      expect(calls).toBe(5); // maxAttempts; not left retrying / stuck PENDING
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "simulateInject skips verification: an unsigned body that ingest() rejects is still recorded + routed",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const { triggerTask, calls, runsByKey } = makeTriggerTaskStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask);

    try {
      const eventId = "evt_simulate_1";
      const body = JSON.stringify({ id: eventId, type: "payment_intent.succeeded" });
      const unsignedInput = {
        opaqueId: endpoint.opaqueId,
        rawBytes: new TextEncoder().encode(body),
        headers: {},
        url: `https://api.example.com/webhooks/v1/ingest/${endpoint.opaqueId}`,
      };

      const rejected = await engine.ingest(unsignedInput);
      expect(rejected.outcome).toBe("verification_failed");

      const simulated = await engine.simulateInject(unsignedInput);
      expect(simulated.outcome).toBe("accepted");
      if (simulated.outcome !== "accepted") return;

      await waitFor(async () => {
        const d = await prisma.webhookDelivery.findFirst({ where: { id: simulated.deliveryId } });
        return d?.status === "SUCCEEDED";
      });

      const delivery = await prisma.webhookDelivery.findFirst({
        where: { id: simulated.deliveryId },
      });
      expect(delivery?.runId).toBe("run_1");
      expect(delivery?.externalDeliveryId).toBe(eventId);
      expect(delivery?.errorMessage).toBeNull();

      expect(calls).toHaveLength(1);
      expect(runsByKey.size).toBe(1);
      expect(calls[0].taskId).toBe("handle-stripe-task");
      expect(calls[0].idempotencyKey).toBe(`${endpoint.id}:${eventId}`);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "simulateInject honors the endpoint filter: a non-matching event is recorded FILTERED, not routed",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma, {
      filter: "event.type == 'payment_intent.succeeded'",
    });
    const { triggerTask, calls } = makeTriggerTaskStub();
    const engine = buildEngine(prisma, redisOptions, triggerTask);

    try {
      const body = JSON.stringify({ id: "evt_simulate_filtered", type: "charge.refunded" });
      const simulated = await engine.simulateInject({
        opaqueId: endpoint.opaqueId,
        rawBytes: new TextEncoder().encode(body),
        headers: {},
        url: `https://api.example.com/webhooks/v1/ingest/${endpoint.opaqueId}`,
      });
      expect(simulated.outcome).toBe("accepted");
      if (simulated.outcome !== "accepted") return;

      const delivery = await prisma.webhookDelivery.findFirst({
        where: { id: simulated.deliveryId },
      });
      expect(delivery?.status).toBe("FILTERED");
      expect(calls).toHaveLength(0);
    } finally {
      await engine.quit();
    }
  }
);
