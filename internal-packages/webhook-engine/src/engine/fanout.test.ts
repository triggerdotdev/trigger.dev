import { createHmac, randomBytes } from "node:crypto";
import { containerTestWithIsolatedRedisNoClickhouse } from "@internal/testcontainers";
import type { RedisOptions } from "@internal/redis";
import type { PrismaClient, Prisma } from "@trigger.dev/database";
import type { StoredWebhookRoutingTarget, WebhookDeliveryTargetResult } from "@trigger.dev/core/v3";
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

const SECRET = "whsec_fanout_secret";
const SECRET_KEY = "secretref_fanout";

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

type TargetInput =
  | { type: "task"; id: string; taskId: string; filter?: string }
  | {
      type: "session";
      id: string;
      taskIdentifier: string;
      keyTemplate: string;
      deliverAs?: "action" | "message";
      actionType?: string;
      filter?: string;
    };

function storedTarget(target: TargetInput): StoredWebhookRoutingTarget {
  const base: StoredWebhookRoutingTarget =
    target.type === "task" ? { ...target } : { ...target, deliverAs: target.deliverAs ?? "action" };
  if (!target.filter) return base;
  return { ...base, filterAst: parseFilter(target.filter), filterAstVersion: 1 };
}

async function createSharedEndpoint(
  prisma: PrismaClient,
  targets: TargetInput[],
  over?: { metadata?: Record<string, unknown>; declaredId?: string }
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
      declaredId: over?.declaredId ?? "payments",
      routingTargets: targets.map(storedTarget) as unknown as Prisma.InputJsonValue,
      verifierArtifact: { kind: "config", config: VERIFIER_CONFIG },
      metadata: (over?.metadata ?? {}) as Prisma.InputJsonValue,
      signingSecretKey: SECRET_KEY,
      status: "ACTIVE",
    },
  });
}

function signedInput(opaqueId: string, event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return {
    opaqueId,
    rawBytes: new TextEncoder().encode(body),
    headers: { "stripe-signature": `t=${t},v1=${sig}` },
    url: `https://api.example.com/webhooks/v1/ingest/${opaqueId}`,
  };
}

function makeTaskPort(behaviour?: (params: TriggerWebhookTaskParams, call: number) => unknown) {
  const calls: TriggerWebhookTaskParams[] = [];
  const runsByKey = new Map<string, string>();
  const triggerTask: TriggerWebhookTaskCallback = async (params) => {
    calls.push(params);
    const override = behaviour?.(params, calls.length);
    if (override) return override as Awaited<ReturnType<TriggerWebhookTaskCallback>>;
    const scoped = `${params.taskId}:${params.idempotencyKey}`;
    let runId = runsByKey.get(scoped);
    if (!runId) {
      runId = `run_${runsByKey.size + 1}`;
      runsByKey.set(scoped, runId);
    }
    return { success: true, runId };
  };
  return { triggerTask, calls, runsByKey };
}

function makeSessionPort(
  behaviour?: (params: DeliverWebhookToSessionParams, call: number) => unknown
) {
  const calls: DeliverWebhookToSessionParams[] = [];
  const claimedParts = new Set<string>();
  const appended: Array<{ externalId: string; partId: string; targetId: string }> = [];
  const deliverToSession: DeliverWebhookToSessionCallback = async (params) => {
    calls.push(params);
    const override = behaviour?.(params, calls.length);
    if (override) return override as Awaited<ReturnType<DeliverWebhookToSessionCallback>>;
    const claimKey = `${params.externalId}:${params.partId}`;
    if (!claimedParts.has(claimKey)) {
      claimedParts.add(claimKey);
      appended.push({
        externalId: params.externalId,
        partId: params.partId,
        targetId: params.targetId,
      });
    }
    return { success: true, runId: `srun_${params.externalId}` };
  };
  return { deliverToSession, calls, appended };
}

function buildEngine(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  triggerTask: TriggerWebhookTaskCallback,
  deliverToSession?: DeliverWebhookToSessionCallback
) {
  return new WebhookEngine({
    prisma,
    redis: redisOptions,
    worker: { concurrency: 1, pollIntervalMs: 50 },
    triggerTask,
    deliverToSession,
    resolveSigningSecret: async (key) => (key === SECRET_KEY ? SECRET : undefined),
    logLevel: "error",
  });
}

async function waitForStatus(
  prisma: PrismaClient,
  deliveryId: string,
  statuses: string[],
  timeoutMs = 15_000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const delivery = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId } });
    if (delivery && statuses.includes(delivery.status)) return delivery;
    await new Promise((r) => setTimeout(r, 50));
  }
  const last = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId } });
  throw new Error(
    `delivery ${deliveryId} never reached ${statuses.join("|")}; last status ${last?.status}, targets ${JSON.stringify(last?.targets)}, error ${last?.errorMessage}`
  );
}

function targetsOf(delivery: { targets: unknown }): WebhookDeliveryTargetResult[] {
  return delivery.targets as WebhookDeliveryTargetResult[];
}

async function ingestAccepted(
  engine: WebhookEngine,
  opaqueId: string,
  event: Record<string, unknown>
) {
  const result = await engine.ingest(signedInput(opaqueId, event));
  expect(result.outcome).toBe("accepted");
  if (result.outcome !== "accepted") throw new Error(`ingest ${result.outcome}`);
  return result;
}

containerTestWithIsolatedRedisNoClickhouse(
  "one endpoint fans a delivery out to a task target and a session target",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSharedEndpoint(
      prisma,
      [
        { type: "task", id: "orders", taskId: "orders" },
        {
          type: "session",
          id: "agent-x:order-events",
          taskIdentifier: "agent-x",
          keyTemplate: "{body.data.customer}",
          actionType: "order.event",
        },
      ],
      { metadata: { team: "billing" } }
    );
    const task = makeTaskPort();
    const session = makeSessionPort();
    const engine = buildEngine(prisma, redisOptions, task.triggerTask, session.deliverToSession);

    try {
      const event = {
        id: "evt_fan_1",
        type: "checkout.session.completed",
        data: { customer: "cus_1" },
      };
      const { deliveryId } = await ingestAccepted(engine, endpoint.opaqueId, event);
      const delivery = await waitForStatus(prisma, deliveryId, ["SUCCEEDED", "FAILED"]);

      expect(delivery.status).toBe("SUCCEEDED");
      expect(delivery.runId).toBe("run_1");
      expect(targetsOf(delivery)).toEqual([
        { id: "orders", type: "task", status: "SUCCEEDED", runId: "run_1" },
        {
          id: "agent-x:order-events",
          type: "session",
          deliverAs: "action",
          status: "SUCCEEDED",
          runId: "srun_cus_1",
        },
      ]);

      const endpointContext = {
        id: endpoint.friendlyId,
        declaredId: "payments",
        metadata: { team: "billing" },
      };

      expect(task.calls).toHaveLength(1);
      expect(task.calls[0]).toMatchObject({
        taskId: "orders",
        targetId: "orders",
        idempotencyKey: `${endpoint.id}:evt_fan_1`,
        payload: event,
        endpoint: endpointContext,
      });

      expect(session.calls).toHaveLength(1);
      expect(session.calls[0]).toMatchObject({
        taskIdentifier: "agent-x",
        targetId: "agent-x:order-events",
        externalId: "cus_1",
        actionType: "order.event",
        deliveryId: delivery.friendlyId,
        externalDeliveryId: "evt_fan_1",
        partId: `${deliveryId}:agent-x:order-events`,
        endpoint: endpointContext,
      });
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "per-target filters route only the targets whose filter passes and record why the others did not",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSharedEndpoint(prisma, [
      { type: "task", id: "paid", taskId: "paid", filter: "event.type == 'invoice.paid'" },
      { type: "task", id: "failed", taskId: "failed", filter: "event.type == 'invoice.failed'" },
      {
        type: "session",
        id: "agent-x:invoices",
        taskIdentifier: "agent-x",
        keyTemplate: "{body.customer}",
        filter: "event.amount > 100",
      },
    ]);
    const task = makeTaskPort();
    const session = makeSessionPort();
    const engine = buildEngine(prisma, redisOptions, task.triggerTask, session.deliverToSession);

    try {
      const { deliveryId } = await ingestAccepted(engine, endpoint.opaqueId, {
        id: "evt_filter_1",
        type: "invoice.paid",
        amount: 50,
        customer: "cus_2",
      });
      const delivery = await waitForStatus(prisma, deliveryId, ["SUCCEEDED", "FAILED"]);

      expect(delivery.status).toBe("SUCCEEDED");
      const targets = targetsOf(delivery);
      expect(targets.map((t) => [t.id, t.status])).toEqual([
        ["paid", "SUCCEEDED"],
        ["failed", "FILTERED"],
        ["agent-x:invoices", "FILTERED"],
      ]);
      expect(targets[1].reason).toContain("invoice.failed");
      expect(targets[2].reason).toContain("amount");

      expect(task.calls.map((c) => c.taskId)).toEqual(["paid"]);
      expect(session.calls).toHaveLength(0);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a delivery no target passes is FILTERED at ingest with no deliver job, and so is one to an endpoint with no subscribers",
  async ({ prisma, redisOptions }) => {
    const filtered = await createSharedEndpoint(prisma, [
      { type: "task", id: "paid", taskId: "paid", filter: "event.type == 'invoice.paid'" },
    ]);
    const empty = await createSharedEndpoint(prisma, [], { declaredId: "unused" });
    const task = makeTaskPort();
    const engine = buildEngine(prisma, redisOptions, task.triggerTask);

    try {
      const first = await ingestAccepted(engine, filtered.opaqueId, {
        id: "evt_nomatch_1",
        type: "invoice.created",
      });
      const second = await ingestAccepted(engine, empty.opaqueId, { id: "evt_empty_1", type: "x" });

      const filteredDelivery = await prisma.webhookDelivery.findFirst({
        where: { id: first.deliveryId },
      });
      expect(filteredDelivery?.status).toBe("FILTERED");
      expect(targetsOf(filteredDelivery!)).toEqual([
        {
          id: "paid",
          type: "task",
          status: "FILTERED",
          reason: expect.stringContaining("invoice.paid"),
        },
      ]);
      expect(await engine.isDeliveryQueued(first.deliveryId)).toBeFalsy();

      const emptyDelivery = await prisma.webhookDelivery.findFirst({
        where: { id: second.deliveryId },
      });
      expect(emptyDelivery?.status).toBe("FILTERED");
      expect(targetsOf(emptyDelivery!)).toEqual([]);
      expect(await engine.isDeliveryQueued(second.deliveryId)).toBeFalsy();

      await new Promise((r) => setTimeout(r, 300));
      expect(task.calls).toHaveLength(0);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a retry after a transient target failure skips the targets that already succeeded",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSharedEndpoint(prisma, [
      { type: "task", id: "orders", taskId: "orders" },
      {
        type: "session",
        id: "agent-x:order-events",
        taskIdentifier: "agent-x",
        keyTemplate: "{body.customer}",
      },
    ]);
    const task = makeTaskPort();
    const session = makeSessionPort((_params, call) =>
      call === 1
        ? { success: false, errorType: "SYSTEM_ERROR", error: "s2 unavailable" }
        : undefined
    );
    const engine = buildEngine(prisma, redisOptions, task.triggerTask, session.deliverToSession);

    try {
      const { deliveryId } = await ingestAccepted(engine, endpoint.opaqueId, {
        id: "evt_retry_1",
        type: "order.created",
        customer: "cus_3",
      });
      const delivery = await waitForStatus(prisma, deliveryId, ["SUCCEEDED", "FAILED"]);

      expect(delivery.status).toBe("SUCCEEDED");
      expect(targetsOf(delivery).map((t) => [t.id, t.status])).toEqual([
        ["orders", "SUCCEEDED"],
        ["agent-x:order-events", "SUCCEEDED"],
      ]);
      expect(task.calls).toHaveLength(1);
      expect(session.calls).toHaveLength(2);
      expect(session.calls[0].partId).toBe(session.calls[1].partId);
    } finally {
      await engine.quit();
    }
  },
  30_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a terminal target failure fails the delivery, names the target, and keeps the other target's success",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSharedEndpoint(prisma, [
      { type: "task", id: "orders", taskId: "orders" },
      {
        type: "session",
        id: "agent-x:order-events",
        taskIdentifier: "agent-x",
        keyTemplate: "{body.customer}",
      },
    ]);
    const task = makeTaskPort();
    const session = makeSessionPort(() => ({
      success: false,
      error: "Session is closed or expired",
    }));
    const engine = buildEngine(prisma, redisOptions, task.triggerTask, session.deliverToSession);

    try {
      const { deliveryId } = await ingestAccepted(engine, endpoint.opaqueId, {
        id: "evt_terminal_1",
        type: "order.created",
        customer: "cus_4",
      });
      const delivery = await waitForStatus(prisma, deliveryId, ["SUCCEEDED", "FAILED"]);

      expect(delivery.status).toBe("FAILED");
      expect(delivery.errorMessage).toContain("agent-x:order-events");
      expect(delivery.errorMessage).toContain("Session is closed or expired");
      expect(delivery.runId).toBe("run_1");
      expect(targetsOf(delivery)).toEqual([
        { id: "orders", type: "task", status: "SUCCEEDED", runId: "run_1" },
        {
          id: "agent-x:order-events",
          type: "session",
          deliverAs: "action",
          status: "FAILED",
          error: "Session is closed or expired",
        },
      ]);
      expect(session.calls).toHaveLength(1);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "two same-agent session targets resolving to one session each append their own action",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSharedEndpoint(prisma, [
      {
        type: "session",
        id: "agent-x:orders",
        taskIdentifier: "agent-x",
        keyTemplate: "{body.customer}",
        actionType: "order",
      },
      {
        type: "session",
        id: "agent-x:payments",
        taskIdentifier: "agent-x",
        keyTemplate: "{body.customer}",
        actionType: "payment",
      },
    ]);
    const task = makeTaskPort();
    const session = makeSessionPort();
    const engine = buildEngine(prisma, redisOptions, task.triggerTask, session.deliverToSession);

    try {
      const { deliveryId } = await ingestAccepted(engine, endpoint.opaqueId, {
        id: "evt_same_agent_1",
        type: "charge.succeeded",
        customer: "cus_5",
      });
      const delivery = await waitForStatus(prisma, deliveryId, ["SUCCEEDED", "FAILED"]);

      expect(delivery.status).toBe("SUCCEEDED");
      expect(session.appended).toHaveLength(2);
      expect(new Set(session.appended.map((a) => a.externalId))).toEqual(new Set(["cus_5"]));
      expect(session.appended.map((a) => a.partId).sort()).toEqual(
        [`${deliveryId}:agent-x:orders`, `${deliveryId}:agent-x:payments`].sort()
      );
      expect(session.calls.map((c) => c.actionType).sort()).toEqual(["order", "payment"]);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a replay to a session target appends again, and a replay with targetId runs only that target past its filter",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSharedEndpoint(prisma, [
      { type: "task", id: "orders", taskId: "orders" },
      {
        type: "session",
        id: "agent-x:order-events",
        taskIdentifier: "agent-x",
        keyTemplate: "{body.customer}",
      },
      { type: "task", id: "refunds", taskId: "refunds", filter: "event.type == 'charge.refunded'" },
    ]);
    const task = makeTaskPort();
    const session = makeSessionPort();
    const engine = buildEngine(prisma, redisOptions, task.triggerTask, session.deliverToSession);

    try {
      const { deliveryId } = await ingestAccepted(engine, endpoint.opaqueId, {
        id: "evt_replay_1",
        type: "order.created",
        customer: "cus_6",
      });
      const original = await waitForStatus(prisma, deliveryId, ["SUCCEEDED", "FAILED"]);
      expect(session.appended).toHaveLength(1);

      const replay = await engine.replayDelivery({
        id: original.id,
        createdAt: original.createdAt,
      });
      expect(replay.outcome).toBe("replayed");
      if (replay.outcome !== "replayed") return;
      const replayed = await waitForStatus(prisma, replay.deliveryId, ["SUCCEEDED", "FAILED"]);

      expect(replayed.status).toBe("SUCCEEDED");
      expect(replayed.externalDeliveryId).toBe("evt_replay_1");
      expect(targetsOf(replayed).map((t) => [t.id, t.status])).toEqual([
        ["orders", "SUCCEEDED"],
        ["agent-x:order-events", "SUCCEEDED"],
        ["refunds", "FILTERED"],
      ]);
      expect(session.appended).toHaveLength(2);
      expect(session.appended[1].partId).toBe(`${replay.deliveryId}:agent-x:order-events`);
      expect(task.runsByKey.size).toBe(2);

      const single = await engine.replayDelivery({
        id: original.id,
        createdAt: original.createdAt,
        targetId: "refunds",
      });
      expect(single.outcome).toBe("replayed");
      if (single.outcome !== "replayed") return;
      const singleDelivery = await waitForStatus(prisma, single.deliveryId, [
        "SUCCEEDED",
        "FAILED",
      ]);

      expect(targetsOf(singleDelivery)).toEqual([
        {
          id: "refunds",
          type: "task",
          taskId: "refunds",
          status: "SUCCEEDED",
          runId: expect.any(String),
        },
      ]);
      expect(task.calls.at(-1)?.taskId).toBe("refunds");
      expect(session.appended).toHaveLength(2);

      const unknown = await engine.replayDelivery({
        id: original.id,
        createdAt: original.createdAt,
        targetId: "nope",
      });
      expect(unknown.outcome).toBe("target_not_found");
    } finally {
      await engine.quit();
    }
  },
  30_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a replay asks authorize about exactly the subscribers it will run, and a refusal creates nothing",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSharedEndpoint(prisma, [
      { type: "task", id: "orders", taskId: "orders", filter: "event.type == 'order.created'" },
      { type: "task", id: "refunds", taskId: "refunds", filter: "event.type == 'charge.refunded'" },
      {
        type: "session",
        id: "agent-x:order-events",
        taskIdentifier: "agent-x",
        keyTemplate: "{body.customer}",
      },
    ]);
    const task = makeTaskPort();
    const session = makeSessionPort();
    const engine = buildEngine(prisma, redisOptions, task.triggerTask, session.deliverToSession);

    try {
      const { deliveryId } = await ingestAccepted(engine, endpoint.opaqueId, {
        id: "evt_authz_1",
        type: "order.created",
        customer: "cus_authz",
      });
      const original = await waitForStatus(prisma, deliveryId, ["SUCCEEDED", "FAILED"]);
      const before = await prisma.webhookDelivery.count();

      const asked: Array<Array<{ id: string; type: string; taskId: string }>> = [];
      const refused = await engine.replayDelivery({
        id: original.id,
        createdAt: original.createdAt,
        authorize: (subscribers) => {
          asked.push(subscribers);
          return subscribers.filter((s) => s.taskId === "agent-x").map((s) => s.taskId);
        },
      });
      expect(asked).toEqual([
        [
          { id: "orders", type: "task", taskId: "orders" },
          { id: "agent-x:order-events", type: "session", taskId: "agent-x" },
        ],
      ]);
      expect(refused).toEqual({ outcome: "forbidden", denied: ["agent-x"] });
      expect(await prisma.webhookDelivery.count()).toBe(before);

      const allowed = await engine.replayDelivery({
        id: original.id,
        createdAt: original.createdAt,
        targetId: "orders",
        authorize: () => [],
      });
      expect(allowed.outcome).toBe("replayed");
    } finally {
      await engine.quit();
    }
  },
  30_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a replayed subscriber that now points at another task fails instead of running",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSharedEndpoint(prisma, [
      { type: "task", id: "orders", taskId: "orders" },
    ]);
    const task = makeTaskPort();
    const engine = buildEngine(prisma, redisOptions, task.triggerTask);

    try {
      const { deliveryId } = await ingestAccepted(engine, endpoint.opaqueId, {
        id: "evt_retarget_1",
        type: "order.created",
      });
      const original = await waitForStatus(prisma, deliveryId, ["SUCCEEDED", "FAILED"]);

      // The subscriber is retargeted after the caller was authorized but before the job runs.
      const replay = await engine.replayDelivery({
        id: original.id,
        createdAt: original.createdAt,
        authorize: async () => {
          await prisma.webhookEndpoint.update({
            where: { id: endpoint.id },
            data: { routingTargets: [{ type: "task", id: "orders", taskId: "admin-tools" }] },
          });
          return [];
        },
      });
      if (replay.outcome !== "replayed") throw new Error(replay.outcome);

      const replayed = await waitForStatus(prisma, replay.deliveryId, ["SUCCEEDED", "FAILED"]);
      expect(replayed.status).toBe("FAILED");
      expect(targetsOf(replayed)).toEqual([
        expect.objectContaining({ id: "orders", status: "FAILED", taskId: "orders" }),
      ]);
      expect(task.calls.map((c) => c.taskId)).not.toContain("admin-tools");
    } finally {
      await engine.quit();
    }
  },
  30_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a replayed task subscriber redeployed as a session for the same task fails instead of delivering",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createSharedEndpoint(prisma, [
      { type: "task", id: "agent-x", taskId: "agent-x" },
    ]);
    const task = makeTaskPort();
    const session = makeSessionPort();
    const engine = buildEngine(prisma, redisOptions, task.triggerTask, session.deliverToSession);

    try {
      const { deliveryId } = await ingestAccepted(engine, endpoint.opaqueId, {
        id: "evt_retype_1",
        type: "order.created",
        customer: "cus_retype",
      });
      const original = await waitForStatus(prisma, deliveryId, ["SUCCEEDED", "FAILED"]);

      // Authorized as a task; the same id and task come back as a session before the job runs.
      const replay = await engine.replayDelivery({
        id: original.id,
        createdAt: original.createdAt,
        authorize: async () => {
          await prisma.webhookEndpoint.update({
            where: { id: endpoint.id },
            data: {
              routingTargets: [
                {
                  type: "session",
                  id: "agent-x",
                  taskIdentifier: "agent-x",
                  keyTemplate: "{body.customer}",
                  deliverAs: "action",
                },
              ],
            },
          });
          return [];
        },
      });
      if (replay.outcome !== "replayed") throw new Error(replay.outcome);

      const replayed = await waitForStatus(prisma, replay.deliveryId, ["SUCCEEDED", "FAILED"]);
      expect(replayed.status).toBe("FAILED");
      expect(targetsOf(replayed)).toEqual([
        expect.objectContaining({ id: "agent-x", type: "task", status: "FAILED" }),
      ]);
      expect(session.calls).toHaveLength(0);
    } finally {
      await engine.quit();
    }
  },
  30_000
);
