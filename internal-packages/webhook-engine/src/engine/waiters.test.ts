import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerTestWithIsolatedRedisNoClickhouse } from "@internal/testcontainers";
import {
  createRedisClient,
  createRedisClusterClient,
  type Cluster,
  type RedisOptions,
} from "@internal/redis";
import type { Meter } from "@internal/tracing";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import type { StoredWebhookRoutingTarget, WebhookDeliveryTargetResult } from "@trigger.dev/core/v3";
import { WebhookEndpointId } from "@trigger.dev/core/v3/isomorphic";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { WebhookEngine } from "./index.js";
import { WebhookWaiterStore } from "./waiters/store.js";
import { waiterShape } from "./waiters/match.js";
import type {
  TriggerWebhookTaskCallback,
  TriggerWebhookTaskParams,
  WebhookWaiterLimits,
  WebhookWaiterOutput,
  WebhookWaitpointPorts,
} from "./types.js";

/**
 * With WEBHOOK_WAITERS_REDIS_CLUSTER=1 every test here runs its waiter store on a local three-node
 * Redis Cluster (redis-server and redis-cli on PATH), the topology production uses, so a script
 * whose keys span slots fails with CROSSSLOT here instead of in production. A standalone Redis
 * can't detect that. Jobs and the front gate's job queue stay on the test's own Redis.
 */
const CLUSTER = process.env.WEBHOOK_WAITERS_REDIS_CLUSTER === "1";
let clusterPorts: number[] = [];
let clusterAdmin: Cluster | undefined;
const clusterProcs: ChildProcess[] = [];
let clusterDir = "";

function redisBinary(name: string) {
  const dir = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].find((candidate) =>
    existsSync(join(candidate, name))
  );
  if (!dir) throw new Error(`${name} not found; WEBHOOK_WAITERS_REDIS_CLUSTER needs it installed`);
  return join(dir, name);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("local Redis Cluster did not come up");
}

beforeAll(async () => {
  if (!CLUSTER) return;
  clusterDir = mkdtempSync(join(tmpdir(), "webhook-waiters-cluster-"));
  clusterPorts = [await freePort(), await freePort(), await freePort()];
  for (const port of clusterPorts) {
    const busPort = await freePort();
    clusterProcs.push(
      spawn(
        redisBinary("redis-server"),
        [
          "--port",
          String(port),
          "--cluster-enabled",
          "yes",
          "--cluster-port",
          String(busPort),
          "--cluster-config-file",
          join(clusterDir, `nodes-${port}.conf`),
          "--cluster-node-timeout",
          "2000",
          "--dir",
          clusterDir,
          "--save",
          "",
          "--appendonly",
          "no",
        ],
        { stdio: "ignore" }
      )
    );
  }
  for (const port of clusterPorts) {
    await until(() =>
      execFileSync(redisBinary("redis-cli"), ["-p", String(port), "ping"])
        .toString()
        .includes("PONG")
    );
  }
  execFileSync(
    redisBinary("redis-cli"),
    [
      "--cluster",
      "create",
      ...clusterPorts.map((port) => `127.0.0.1:${port}`),
      "--cluster-replicas",
      "0",
      "--cluster-yes",
    ],
    { stdio: "ignore" }
  );
  await until(() =>
    execFileSync(redisBinary("redis-cli"), ["-p", String(clusterPorts[0]), "cluster", "info"])
      .toString()
      .includes("cluster_state:ok")
  );
  clusterAdmin = createRedisClusterClient({ nodes: clusterNodes() });
  await until(async () => (await clusterAdmin!.set("{warmup}probe", "1")) === "OK");
}, 60_000);

beforeEach(async () => {
  if (!clusterAdmin) return;
  await Promise.all(clusterAdmin.nodes("master").map((node) => node.flushall()));
});

afterAll(async () => {
  if (!CLUSTER) return;
  await clusterAdmin?.quit().catch(() => {});
  for (const port of clusterPorts) {
    try {
      execFileSync(redisBinary("redis-cli"), ["-p", String(port), "shutdown", "nosave"], {
        stdio: "ignore",
      });
    } catch {}
  }
  for (const proc of clusterProcs) proc.kill("SIGKILL");
  if (clusterDir) rmSync(clusterDir, { recursive: true, force: true });
});

function clusterNodes() {
  return clusterPorts.map((port) => ({ host: "127.0.0.1", port }));
}

/** A client on whichever Redis the engine's waiter store uses in this run. */
function waiterStoreClient(redisOptions: RedisOptions) {
  return CLUSTER
    ? createRedisClusterClient({ nodes: clusterNodes() })
    : createRedisClient({ ...redisOptions, keyPrefix: undefined });
}

function inMemoryMetrics() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const provider = new MeterProvider({ readers: [reader] });
  return {
    meter: provider.getMeter("webhook-engine-test"),
    /** Each data point of a metric: a counter's sum, or how many samples a histogram took. */
    async points(name: string) {
      await reader.forceFlush();
      const metric = exporter
        .getMetrics()
        .at(-1)
        ?.scopeMetrics.flatMap((scope) => scope.metrics)
        .find((m) => m.descriptor.name === name);
      return (metric?.dataPoints ?? [])
        .map((point) => ({
          attributes: point.attributes,
          value: typeof point.value === "number" ? point.value : point.value.count,
        }))
        .sort((a, b) => JSON.stringify(a.attributes).localeCompare(JSON.stringify(b.attributes)));
    },
    shutdown: () => provider.shutdown(),
  };
}

const SECRET = "whsec_waiter_secret";
const SECRET_KEY = "secretref_waiter";

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

async function createEndpoint(
  prisma: PrismaClient,
  targets: StoredWebhookRoutingTarget[] = [],
  declaredId = "payments"
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
      declaredId,
      routingTargets: targets as unknown as Prisma.InputJsonValue,
      verifierArtifact: { kind: "config", config: VERIFIER_CONFIG },
      metadata: { team: "billing" },
      signingSecretKey: SECRET_KEY,
      status: "ACTIVE",
    },
  });
}

function signed(opaqueId: string, event: Record<string, unknown>, path?: string) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return {
    opaqueId,
    rawBytes: new TextEncoder().encode(body),
    headers: { "stripe-signature": `t=${t},v1=${sig}`, "x-order": String(event.id) },
    url: `https://api.example.com${path ?? `/webhooks/v1/ingest/${opaqueId}`}`,
  };
}

type FakeWaitpoint = {
  id: string;
  idempotencyKey: string;
  status: "PENDING" | "COMPLETED";
  timeoutAt: Date;
  tags: string[];
  output?: WebhookWaiterOutput;
  error?: { name: string; message: string; reason?: string };
  completions: number;
};

/** In-memory MANUAL waitpoints: first completion wins, like the run engine. */
function makeWaitpoints(options?: {
  completeBehaviour?: (
    ids: string[],
    call: number
  ) => Array<{ id: string; ok: boolean; error?: string }> | "throw" | undefined;
}) {
  const byId = new Map<string, FakeWaitpoint>();
  const byKey = new Map<string, string>();
  const completeCalls: Array<{ ids: string[]; output: WebhookWaiterOutput }> = [];
  let createCalls = 0;

  const complete = (id: string, patch: Partial<FakeWaitpoint>) => {
    const waitpoint = byId.get(id);
    if (!waitpoint) return;
    waitpoint.completions++;
    if (waitpoint.status === "COMPLETED") return;
    Object.assign(waitpoint, patch, { status: "COMPLETED" });
  };

  const ports: WebhookWaitpointPorts = {
    async find({ idempotencyKey }) {
      const id = byKey.get(idempotencyKey);
      const waitpoint = id ? byId.get(id) : undefined;
      return waitpoint
        ? {
            id: waitpoint.id,
            status: waitpoint.status,
            timeoutAt: waitpoint.timeoutAt,
            tags: waitpoint.tags,
          }
        : undefined;
    },
    async create({ idempotencyKey, timeoutAt, tags }) {
      createCalls++;
      const existing = byKey.get(idempotencyKey);
      if (existing) return { id: existing, isCached: true };
      const id = `waitpoint_${randomUUID().replace(/-/g, "")}`;
      byId.set(id, { id, idempotencyKey, status: "PENDING", timeoutAt, tags, completions: 0 });
      byKey.set(idempotencyKey, id);
      return { id, isCached: false };
    },
    async complete({ waitpointIds, output }) {
      completeCalls.push({ ids: waitpointIds, output });
      const override = options?.completeBehaviour?.(waitpointIds, completeCalls.length);
      if (override === "throw") throw new Error("object store unavailable");
      if (override) {
        for (const result of override) if (result.ok) complete(result.id, { output });
        return override;
      }
      for (const id of waitpointIds) complete(id, { output });
      return waitpointIds.map((id) => ({ id, ok: true }));
    },
    async fail({ waitpointId, error }) {
      complete(waitpointId, { error });
    },
  };

  return {
    ports,
    byId,
    completeCalls,
    get createCalls() {
      return createCalls;
    },
  };
}

function makeTaskPort() {
  const calls: TriggerWebhookTaskParams[] = [];
  const triggerTask: TriggerWebhookTaskCallback = async (params) => {
    calls.push(params);
    return { success: true, runId: `run_${calls.length}` };
  };
  return { triggerTask, calls };
}

function buildEngine(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  waitpoints: WebhookWaitpointPorts,
  over?: {
    triggerTask?: TriggerWebhookTaskCallback;
    limits?: Partial<WebhookWaiterLimits>;
    workerDisabled?: boolean;
    concurrency?: number;
    completionChunkSize?: number;
    exhaustedRecordDelayMs?: number;
    meter?: Meter;
  }
) {
  return new WebhookEngine({
    meter: over?.meter,
    prisma,
    redis: redisOptions,
    worker: {
      concurrency: over?.concurrency ?? 1,
      pollIntervalMs: 50,
      disabled: over?.workerDisabled,
      exhaustedRecordDelayMs: over?.exhaustedRecordDelayMs,
    },
    endpointCache: { ttlMs: 0 },
    triggerTask: over?.triggerTask ?? makeTaskPort().triggerTask,
    resolveSigningSecret: async (key) => (key === SECRET_KEY ? SECRET : undefined),
    waiters: {
      ...(CLUSTER ? { cluster: { nodes: clusterNodes() } } : {}),
      waitpoints,
      limits: over?.limits,
      urlSecret: "waiter-url-secret",
      completionChunkSize: over?.completionChunkSize,
    },
    logLevel: "error",
  });
}

async function waitForDelivery(prisma: PrismaClient, id: string, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const delivery = await prisma.webhookDelivery.findFirst({ where: { id } });
    if (delivery && ["SUCCEEDED", "FAILED", "FILTERED", "UNMATCHED"].includes(delivery.status)) {
      return delivery;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const last = await prisma.webhookDelivery.findFirst({ where: { id } });
  throw new Error(
    `delivery ${id} stuck at ${last?.status}: ${JSON.stringify(last?.targets)} ${last?.errorMessage}`
  );
}

async function accepted(engine: WebhookEngine, input: ReturnType<typeof signed>) {
  const result = await engine.ingest(input);
  if (result.outcome !== "accepted") throw new Error(`ingest ${result.outcome}`);
  return result.deliveryId;
}

async function createdWaiter(
  engine: WebhookEngine,
  over: Partial<Parameters<WebhookEngine["createWaiter"]>[0]>
) {
  const result = await engine.createWaiter({
    environmentId: "env_test",
    projectId: "proj_test",
    endpoint: "payments",
    ...over,
  });
  if (result.outcome !== "created") throw new Error(`createWaiter ${JSON.stringify(result)}`);
  return result;
}

function resumedSummary(count: number) {
  return {
    id: "waiters",
    type: "waiter",
    status: "SUCCEEDED",
    waiters: { matched: count, resumed: count, failed: 0 },
  };
}

function targetsOf(delivery: { targets: unknown }) {
  return delivery.targets as WebhookDeliveryTargetResult[];
}

function orderEvent(orderId: string, extra?: Record<string, unknown>) {
  return {
    id: `evt_${randomUUID()}`,
    type: "payment_intent.succeeded",
    data: { object: { amount: 4200, metadata: { orderId } } },
    ...extra,
  };
}

const MATCH = (orderId: string) => ({
  "event.data.object.metadata.orderId": orderId,
  "event.type": "payment_intent.succeeded",
});

containerTestWithIsolatedRedisNoClickhouse(
  "listed waiters carry the match and filter they were created with",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma, []);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);

    try {
      const matched = await createdWaiter(engine, {
        match: MATCH("ord_list"),
        filter: "event.data.object.amount > 100",
      });
      const byUrl = await createdWaiter(engine, {});

      const { waiters, total } = await engine.listWaiters({ endpointId: endpoint.id });
      expect(total).toBe(2);
      expect(waiters.find((w) => w.id === matched.id)).toMatchObject({
        match: MATCH("ord_list"),
        filter: "event.data.object.amount > 100",
      });
      const listedByUrl = waiters.find((w) => w.id === byUrl.id);
      expect(listedByUrl?.match).toBeUndefined();
      expect(listedByUrl?.filter).toBeUndefined();
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a matching delivery resumes the waiter with the event, and the endpoint's task still fires",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma, [
      { type: "task", id: "orders", taskId: "orders" },
    ]);
    const waitpoints = makeWaitpoints();
    const task = makeTaskPort();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      triggerTask: task.triggerTask,
    });

    try {
      const waiter = await createdWaiter(engine, { match: MATCH("ord_1"), tags: ["checkout"] });
      expect(waiter.urlPath).toBeUndefined();
      expect(waitpoints.byId.get(waiter.id)?.tags).toEqual(["webhook:payments", "checkout"]);

      const event = orderEvent("ord_1");
      const delivery = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, event))
      );

      expect(delivery.status).toBe("SUCCEEDED");
      expect(targetsOf(delivery)).toEqual([
        { id: "orders", type: "task", status: "SUCCEEDED", runId: "run_1" },
        resumedSummary(1),
      ]);
      expect(task.calls).toHaveLength(1);
      expect(task.calls[0]?.deliveryId).toBe(delivery.friendlyId);

      const waitpoint = waitpoints.byId.get(waiter.id);
      expect(waitpoint?.status).toBe("COMPLETED");
      expect(waitpoint?.output).toMatchObject({
        event,
        deliveryId: delivery.friendlyId,
        endpoint: {
          id: endpoint.friendlyId,
          declaredId: "payments",
          metadata: { team: "billing" },
        },
      });
      expect(waitpoint?.output?.headers["x-order"]).toBe(event.id);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a delivery no waiter matches is UNMATCHED when waiters are live, and FILTERED when none are",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);

    try {
      const none = await engine.ingest(signed(endpoint.opaqueId, orderEvent("ord_x")));
      if (none.outcome !== "accepted") throw new Error(none.outcome);
      const filtered = await prisma.webhookDelivery.findFirst({ where: { id: none.deliveryId } });
      expect(filtered?.status).toBe("FILTERED");
      expect(await engine.isDeliveryQueued(none.deliveryId)).toBeFalsy();

      const waiter = await createdWaiter(engine, { match: MATCH("ord_2") });
      const unmatched = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_other")))
      );
      expect(unmatched.status).toBe("UNMATCHED");
      expect(unmatched.filterReason).toBe("no live waiter matched");
      expect(waitpoints.byId.get(waiter.id)?.status).toBe("PENDING");

      expect(await engine.cancelWaiter({ environmentId: "env_test", waiterId: waiter.id })).toEqual(
        {
          outcome: "cancelled",
        }
      );
      const afterCancel = await engine.ingest(
        signed(endpoint.opaqueId, orderEvent("ord_after_cancel"))
      );
      if (afterCancel.outcome !== "accepted") throw new Error(afterCancel.outcome);
      expect(
        (await prisma.webhookDelivery.findFirst({ where: { id: afterCancel.deliveryId } }))?.status
      ).toBe("FILTERED");

      const live = await createdWaiter(engine, { match: MATCH("ord_2") });
      const wrongType = await waitForDelivery(
        prisma,
        await accepted(
          engine,
          signed(endpoint.opaqueId, orderEvent("ord_2", { type: "payment_intent.created" }))
        )
      );
      expect(wrongType.status).toBe("UNMATCHED");
      expect(waitpoints.byId.get(live.id)?.status).toBe("PENDING");
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "several waiters on one key all resume from one delivery, sharing one packet; a filtered-out one keeps waiting",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);

    try {
      const waiters = await Promise.all(
        [1, 2, 3].map(() => createdWaiter(engine, { match: MATCH("ord_3") }))
      );
      const big = await createdWaiter(engine, {
        match: MATCH("ord_3"),
        filter: "event.data.object.amount > 10000",
      });

      const delivery = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_3")))
      );

      expect(delivery.status).toBe("SUCCEEDED");
      expect(waitpoints.completeCalls).toHaveLength(1);
      expect(waitpoints.completeCalls[0].ids.sort()).toEqual(waiters.map((w) => w.id).sort());
      for (const waiter of waiters)
        expect(waitpoints.byId.get(waiter.id)?.status).toBe("COMPLETED");
      expect(waitpoints.byId.get(big.id)?.status).toBe("PENDING");
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "concurrent deliveries matching one waiter claim it once",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, { concurrency: 8 });

    try {
      const waiter = await createdWaiter(engine, { match: MATCH("ord_4") });
      const ids = await Promise.all(
        Array.from({ length: 8 }, () =>
          accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_4")))
        )
      );
      const deliveries = await Promise.all(ids.map((id) => waitForDelivery(prisma, id)));

      expect(deliveries.filter((d) => d.status === "SUCCEEDED")).toHaveLength(1);
      expect(deliveries.filter((d) => d.status === "UNMATCHED")).toHaveLength(7);
      expect(waitpoints.byId.get(waiter.id)?.completions).toBe(1);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "two deliveries that both read a waiter before either claims it: only the first claims it",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, { workerDisabled: true });
    const store = new WebhookWaiterStore(waiterStoreClient(redisOptions), "", {
      perEnvironment: 1000,
      perEndpoint: 100,
      shapes: 25,
    });

    try {
      const waiter = await createdWaiter(engine, { match: MATCH("ord_race") });
      const { shape, values } = waiterShape(MATCH("ord_race"));
      const staleRead = [{ shape, values, ids: [waiter.id] }];

      const first = await store.claim(endpoint.id, "delivery_a", staleRead);
      const second = await store.claim(endpoint.id, "delivery_b", staleRead);
      expect(first).toEqual({ decided: false, claimed: 1, failed: 0, ids: [waiter.id] });
      expect(second).toEqual({ decided: false, claimed: 0, failed: 0, ids: [] });

      expect(await store.claim(endpoint.id, "delivery_a", [])).toEqual({
        decided: true,
        claimed: 1,
        failed: 0,
        ids: [waiter.id],
      });
    } finally {
      await store.quit();
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a delivery that arrived before the waiter was created never resumes it, even from a backed-up queue",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const ingestOnly = buildEngine(prisma, redisOptions, waitpoints.ports, {
      workerDisabled: true,
    });

    const early = await createdWaiter(ingestOnly, { match: MATCH("ord_other") });
    const oldDeliveryId = await accepted(
      ingestOnly,
      signed(endpoint.opaqueId, orderEvent("ord_5"))
    );
    await new Promise((r) => setTimeout(r, 20));
    const waiter = await createdWaiter(ingestOnly, { match: MATCH("ord_5") });
    await ingestOnly.quit();

    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);
    try {
      const old = await waitForDelivery(prisma, oldDeliveryId);
      expect(old.status).toBe("UNMATCHED");
      expect(waitpoints.byId.get(waiter.id)?.status).toBe("PENDING");
      expect(waitpoints.byId.get(early.id)?.status).toBe("PENDING");

      const fresh = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_5")))
      );
      expect(fresh.status).toBe("SUCCEEDED");
      expect(waitpoints.byId.get(waiter.id)?.status).toBe("COMPLETED");
    } finally {
      await engine.quit();
    }
  },
  30_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "an expired waiter is pruned: it isn't matched and its slot is free again",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      limits: { perEndpoint: 1 },
    });

    try {
      await createdWaiter(engine, { match: MATCH("ord_6"), timeoutAt: new Date(Date.now() + 700) });
      const full = await engine.createWaiter({
        environmentId: "env_test",
        projectId: "proj_test",
        endpoint: "payments",
        match: MATCH("ord_7"),
      });
      expect(full).toMatchObject({ outcome: "limit", reason: "endpoint_limit" });

      await new Promise((r) => setTimeout(r, 900));

      const result = await engine.ingest(signed(endpoint.opaqueId, orderEvent("ord_6")));
      if (result.outcome !== "accepted") throw new Error(result.outcome);
      const delivery = await prisma.webhookDelivery.findFirst({ where: { id: result.deliveryId } });
      expect(delivery?.status).toBe("FILTERED");

      await createdWaiter(engine, { match: MATCH("ord_7") });
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "every limit is enforced at create, and an over-limit create allocates no waitpoint",
  async ({ prisma, redisOptions }) => {
    await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      limits: { perEndpoint: 5, shapes: 2 },
    });
    const create = (over: Partial<Parameters<WebhookEngine["createWaiter"]>[0]>) =>
      engine.createWaiter({
        environmentId: "env_test",
        projectId: "proj_test",
        endpoint: "payments",
        ...over,
      });

    try {
      await createdWaiter(engine, { match: MATCH("ord_k") });
      await createdWaiter(engine, { match: MATCH("ord_k") });
      await createdWaiter(engine, { match: MATCH("ord_k") });
      const before = waitpoints.createCalls;

      await createdWaiter(engine, { match: { "event.data.object.id": "pi_1" } });
      expect(await create({ match: { "event.data.object.customer": "cus_1" } })).toMatchObject({
        outcome: "limit",
        reason: "shape_limit",
      });

      await createdWaiter(engine, { match: MATCH("ord_l") });
      expect(await create({ match: MATCH("ord_m") })).toMatchObject({
        outcome: "limit",
        reason: "endpoint_limit",
      });
      expect(waitpoints.createCalls).toBe(before + 2);

      expect(
        await create({ match: MATCH("ord_n"), timeoutAt: new Date(Date.now() + 91 * 86_400_000) })
      ).toMatchObject({
        outcome: "limit",
        reason: "timeout_too_long",
      });
      expect(
        await create({
          match: {
            "event.a": "1",
            "event.b": "2",
            "event.c": "3",
            "event.d": "4",
            "event.e": "5",
            "event.f": "6",
          },
        })
      ).toMatchObject({ outcome: "invalid" });
      expect(await create({ match: MATCH("ord_n"), filter: "event.type ==" })).toMatchObject({
        outcome: "filter_invalid",
      });
      expect(await create({ endpoint: "nope", match: MATCH("ord_n") })).toEqual({
        outcome: "endpoint_not_found",
      });
      expect(waitpoints.createCalls).toBe(before + 2);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "cancel fails the wait and frees the slot; cancelling after a claim is too late and the run keeps the event",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      limits: { perEndpoint: 1 },
    });

    try {
      const first = await createdWaiter(engine, { match: MATCH("ord_8") });
      expect(await engine.cancelWaiter({ environmentId: "env_test", waiterId: first.id })).toEqual({
        outcome: "cancelled",
      });
      expect(waitpoints.byId.get(first.id)?.error?.name).toBe("WebhookWaiterCancelledError");

      const second = await createdWaiter(engine, { match: MATCH("ord_8") });
      const delivery = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_8")))
      );
      expect(delivery.status).toBe("SUCCEEDED");

      expect(await engine.cancelWaiter({ environmentId: "env_test", waiterId: second.id })).toEqual(
        {
          outcome: "too_late",
          deliveryId: delivery.id,
        }
      );
      expect(waitpoints.byId.get(second.id)?.output?.deliveryId).toBe(delivery.friendlyId);
      expect(
        await engine.cancelWaiter({ environmentId: "env_other", waiterId: second.id })
      ).toEqual({
        outcome: "not_found",
      });
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a create retried with the same idempotency key returns the same waiter",
  async ({ prisma, redisOptions }) => {
    await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      limits: { perEndpoint: 1 },
    });

    try {
      const first = await createdWaiter(engine, {
        match: MATCH("ord_9"),
        idempotencyKey: "idem-9",
      });
      const retry = await createdWaiter(engine, {
        match: MATCH("ord_9"),
        idempotencyKey: "idem-9",
      });
      expect(retry.id).toBe(first.id);
      expect(retry.isCached).toBe(true);
      expect(waitpoints.createCalls).toBe(1);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a crash after the claim, before completion, completes the claimed waiter on the retry",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const waitpoints = makeWaitpoints({
      completeBehaviour: (_ids, call) => (call === 1 ? "throw" : undefined),
    });
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);

    try {
      const waiter = await createdWaiter(engine, { match: MATCH("ord_10") });
      const delivery = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_10")))
      );

      expect(delivery.status).toBe("SUCCEEDED");
      expect(waitpoints.completeCalls).toHaveLength(2);
      expect(waitpoints.completeCalls[1].ids).toEqual([waiter.id]);
      expect(waitpoints.byId.get(waiter.id)?.status).toBe("COMPLETED");
      expect(targetsOf(delivery)).toEqual([resumedSummary(1)]);
    } finally {
      await engine.quit();
    }
  },
  30_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a completion upload failure for one waiter retries only that waiter",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    let failId: string | undefined;
    const waitpoints = makeWaitpoints({
      completeBehaviour: (ids, call) =>
        call === 1
          ? ids.map((id) => ({
              id,
              ok: id !== failId,
              error: id === failId ? "upload failed" : undefined,
            }))
          : undefined,
    });
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);

    try {
      const a = await createdWaiter(engine, { match: MATCH("ord_11") });
      const b = await createdWaiter(engine, { match: MATCH("ord_11") });
      failId = b.id;

      const delivery = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_11")))
      );

      expect(delivery.status).toBe("SUCCEEDED");
      expect(waitpoints.completeCalls.map((c) => c.ids.length)).toEqual([2, 1]);
      expect(waitpoints.completeCalls[1].ids).toEqual([b.id]);
      expect(waitpoints.byId.get(a.id)?.completions).toBe(1);
      expect(waitpoints.byId.get(b.id)?.status).toBe("COMPLETED");
    } finally {
      await engine.quit();
    }
  },
  30_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a register retried after a delivery claimed the waiter does not make it claimable again",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    let hold = true;
    const waitpoints = makeWaitpoints({
      completeBehaviour: (ids) =>
        hold ? ids.map((id) => ({ id, ok: false, error: "slow store" })) : undefined,
    });
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);

    try {
      const waiter = await createdWaiter(engine, {
        match: MATCH("ord_12"),
        idempotencyKey: "idem-12",
      });
      const first = await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_12")));
      const start = Date.now();
      while (waitpoints.completeCalls.length === 0 && Date.now() - start < 10_000) {
        await new Promise((r) => setTimeout(r, 25));
      }

      const retry = await createdWaiter(engine, {
        match: MATCH("ord_12"),
        idempotencyKey: "idem-12",
      });
      expect(retry.id).toBe(waiter.id);

      const second = await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_12")));
      hold = false;

      const [d1, d2] = await Promise.all([
        waitForDelivery(prisma, first),
        waitForDelivery(prisma, second),
      ]);
      expect(d1.status).toBe("SUCCEEDED");
      expect(d2.status).toBe("UNMATCHED");
      expect(waitpoints.byId.get(waiter.id)?.output?.deliveryId).toBe(d1.friendlyId);
    } finally {
      await engine.quit();
    }
  },
  30_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a URL-matched waiter completes only from its own URL, which never fans out to the endpoint's subscribers",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma, [
      { type: "task", id: "orders", taskId: "orders" },
    ]);
    const waitpoints = makeWaitpoints();
    const task = makeTaskPort();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      triggerTask: task.triggerTask,
    });

    try {
      const waiter = await createdWaiter(engine, {});
      expect(waiter.urlPath).toMatch(
        new RegExp(`^/webhooks/v1/ingest/${endpoint.opaqueId}/w/${waiter.id}\\.[0-9a-f]{24}$`)
      );
      const token = waiter.urlPath!.split("/w/")[1];

      const onEndpoint = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("x")))
      );
      expect(onEndpoint.status).toBe("SUCCEEDED");
      expect(waitpoints.byId.get(waiter.id)?.status).toBe("PENDING");

      const forged = await engine.ingestWaiter({
        ...signed(endpoint.opaqueId, orderEvent("x"), waiter.urlPath),
        waiterToken: `${waiter.id}.000000000000000000000000`,
      });
      expect(forged.outcome).toBe("endpoint_not_found");

      const event = { id: "prediction_1", status: "succeeded", output: ["done"] };
      const result = await engine.ingestWaiter({
        ...signed(endpoint.opaqueId, event, waiter.urlPath),
        waiterToken: token,
      });
      if (result.outcome !== "accepted") throw new Error(result.outcome);
      const delivery = await waitForDelivery(prisma, result.deliveryId);

      expect(delivery.status).toBe("SUCCEEDED");
      expect(targetsOf(delivery)).toEqual([resumedSummary(1)]);
      expect(waitpoints.byId.get(waiter.id)?.output?.event).toEqual(event);
      expect(task.calls).toHaveLength(1);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "more waiters on one value than a chunk resume across completion jobs, each exactly once",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma, [
      { type: "task", id: "orders", taskId: "orders" },
    ]);
    const waitpoints = makeWaitpoints();
    const task = makeTaskPort();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      triggerTask: task.triggerTask,
      completionChunkSize: 3,
      concurrency: 4,
    });

    try {
      const waiters = [];
      for (let i = 0; i < 10; i++) {
        waiters.push(await createdWaiter(engine, { match: MATCH("ord_broadcast") }));
      }

      const delivery = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_broadcast")))
      );

      expect(delivery.status).toBe("SUCCEEDED");
      expect(targetsOf(delivery)).toEqual([
        { id: "orders", type: "task", status: "SUCCEEDED", runId: "run_1" },
        resumedSummary(10),
      ]);
      expect(task.calls).toHaveLength(1);
      for (const waiter of waiters) {
        expect(waitpoints.byId.get(waiter.id)?.completions).toBe(1);
        expect(waitpoints.byId.get(waiter.id)?.output?.deliveryId).toBe(delivery.friendlyId);
      }
      expect(waitpoints.completeCalls.length).toBeGreaterThan(1);
      expect(waitpoints.completeCalls.flatMap((call) => call.ids).sort()).toEqual(
        waiters.map((waiter) => waiter.id).sort()
      );
    } finally {
      await engine.quit();
    }
  },
  30_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a completion job that fails retries only its own unresolved waiters",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    let failId: string | undefined;
    let failed = false;
    const waitpoints = makeWaitpoints({
      completeBehaviour: (ids) => {
        if (failed || !failId || !ids.includes(failId)) return undefined;
        failed = true;
        return ids.map((id) => ({
          id,
          ok: id !== failId,
          error: id === failId ? "upload failed" : undefined,
        }));
      },
    });
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      completionChunkSize: 3,
      concurrency: 4,
    });

    try {
      const waiters = [];
      for (let i = 0; i < 8; i++) {
        waiters.push(await createdWaiter(engine, { match: MATCH("ord_retry") }));
      }
      failId = waiters[5]!.id;

      const delivery = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_retry")))
      );

      expect(delivery.status).toBe("SUCCEEDED");
      expect(targetsOf(delivery)).toEqual([resumedSummary(8)]);
      for (const waiter of waiters) {
        expect(waitpoints.byId.get(waiter.id)?.completions).toBe(1);
      }
      const failIdCalls = waitpoints.completeCalls.filter((call) => call.ids.includes(failId!));
      expect(failIdCalls).toHaveLength(2);
      expect(failIdCalls[1]!.ids).toEqual([failId]);
    } finally {
      await engine.quit();
    }
  },
  30_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a waiter that never resumes is given up on after the last attempt and the delivery fails",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    let failId: string | undefined;
    const waitpoints = makeWaitpoints({
      completeBehaviour: (ids) =>
        failId && ids.includes(failId)
          ? ids.map((id) => ({
              id,
              ok: id !== failId,
              error: id === failId ? "upload failed" : undefined,
            }))
          : undefined,
    });
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      completionChunkSize: 2,
      concurrency: 4,
    });

    try {
      const waiters = [];
      for (let i = 0; i < 5; i++) {
        waiters.push(await createdWaiter(engine, { match: MATCH("ord_dead") }));
      }
      failId = waiters[2]!.id;

      const delivery = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_dead"))),
        120_000
      );

      expect(delivery.status).toBe("FAILED");
      expect(targetsOf(delivery)).toEqual([
        {
          id: "waiters",
          type: "waiter",
          status: "FAILED",
          error: "1 of 5 waiters could not be resumed: upload failed",
          waiters: { matched: 5, resumed: 4, failed: 1 },
        },
      ]);
      expect(waitpoints.byId.get(failId)?.status).toBe("PENDING");
      for (const waiter of waiters.filter((w) => w.id !== failId)) {
        expect(waitpoints.byId.get(waiter.id)?.completions).toBe(1);
      }
    } finally {
      await engine.quit();
    }
  },
  150_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "the environment cap counts waiters across endpoints, and resumed, cancelled and expired ones free their slots",
  async ({ prisma, redisOptions }) => {
    const payments = await createEndpoint(prisma);
    await createEndpoint(prisma, [], "orders-b");
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      limits: { perEnvironment: 3, perEndpoint: 10 },
    });
    const create = (over: Partial<Parameters<WebhookEngine["createWaiter"]>[0]>) =>
      engine.createWaiter({
        environmentId: "env_test",
        projectId: "proj_test",
        endpoint: "payments",
        ...over,
      });

    try {
      const resumed = await createdWaiter(engine, { match: MATCH("ord_env_1") });
      const cancelled = await createdWaiter(engine, {
        endpoint: "orders-b",
        match: MATCH("ord_env_2"),
      });
      await createdWaiter(engine, {
        match: MATCH("ord_env_3"),
        timeoutAt: new Date(Date.now() + 1_500),
      });

      const before = waitpoints.createCalls;
      expect(await create({ endpoint: "orders-b", match: MATCH("ord_env_4") })).toMatchObject({
        outcome: "limit",
        reason: "environment_limit",
      });
      expect(waitpoints.createCalls).toBe(before);

      await engine.cancelWaiter({ environmentId: "env_test", waiterId: cancelled.id });
      await createdWaiter(engine, { endpoint: "orders-b", match: MATCH("ord_env_4") });

      await waitForDelivery(
        prisma,
        await accepted(engine, signed(payments.opaqueId, orderEvent("ord_env_1")))
      );
      expect(waitpoints.byId.get(resumed.id)?.status).toBe("COMPLETED");
      await createdWaiter(engine, { match: MATCH("ord_env_5") });

      expect(await create({ match: MATCH("ord_env_6") })).toMatchObject({
        reason: "environment_limit",
      });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await createdWaiter(engine, { match: MATCH("ord_env_6") });
      expect(await create({ match: MATCH("ord_env_7") })).toMatchObject({
        reason: "environment_limit",
      });
    } finally {
      await engine.quit();
    }
  },
  30_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "limits passed with a create override the engine's, so each org gets its own caps",
  async ({ prisma, redisOptions }) => {
    await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);
    const create = (over: Partial<Parameters<WebhookEngine["createWaiter"]>[0]>) =>
      engine.createWaiter({
        environmentId: "env_test",
        projectId: "proj_test",
        endpoint: "payments",
        ...over,
      });

    try {
      const plan = { perEnvironment: 3, perEndpoint: 2 };
      await createdWaiter(engine, { match: MATCH("ord_plan_1"), limits: plan });
      await createdWaiter(engine, { match: MATCH("ord_plan_2"), limits: plan });
      expect(await create({ match: MATCH("ord_plan_3"), limits: plan })).toMatchObject({
        outcome: "limit",
        reason: "endpoint_limit",
        message: "the endpoint already has 2 live waiters",
      });
      expect(
        await create({ match: MATCH("ord_plan_3"), limits: { perEnvironment: 2, perEndpoint: 10 } })
      ).toMatchObject({ outcome: "limit", reason: "environment_limit" });

      await createdWaiter(engine, { match: MATCH("ord_plan_3") });
      expect(await engine.countLiveWaiters("env_test")).toBe(3);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a waiter cancelled the moment it registers leaves no environment slot behind",
  async ({ prisma, redisOptions }) => {
    await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      limits: { perEnvironment: 5, perEndpoint: 10 },
    });
    const store = (engine as unknown as { waiterStore: WebhookWaiterStore }).waiterStore;
    const register = store.register.bind(store);
    store.register = async (params) => {
      const result = await register(params);
      await engine.cancelWaiter({ environmentId: "env_test", waiterId: params.waiterId });
      return result;
    };

    try {
      await createdWaiter(engine, { match: MATCH("ord_race_env") });
      expect(await store.environmentCount("env_test")).toBe(0);
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a URL-matched waiter's filter still applies to deliveries on its URL",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);

    try {
      const waiter = await createdWaiter(engine, { filter: "event.status == 'succeeded'" });
      const token = waiter.urlPath!.split("/w/")[1]!;
      const send = async (event: Record<string, unknown>) => {
        const result = await engine.ingestWaiter({
          ...signed(endpoint.opaqueId, event, waiter.urlPath),
          waiterToken: token,
        });
        if (result.outcome !== "accepted") throw new Error(result.outcome);
        return waitForDelivery(prisma, result.deliveryId);
      };

      const failed = await send({ id: "prediction_2", status: "failed" });
      expect(failed.status).toBe("UNMATCHED");
      expect(waitpoints.byId.get(waiter.id)?.status).toBe("PENDING");

      const succeeded = await send({ id: "prediction_3", status: "succeeded" });
      expect(succeeded.status).toBe("SUCCEEDED");
      expect(waitpoints.byId.get(waiter.id)?.output?.event).toMatchObject({ id: "prediction_3" });
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a completion job whose resume call keeps throwing gives its chunk up and the delivery fails",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    let poisoned: string | undefined;
    const waitpoints = makeWaitpoints({
      completeBehaviour: (ids) => (poisoned && ids.includes(poisoned) ? "throw" : undefined),
    });
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      completionChunkSize: 2,
      concurrency: 4,
    });

    try {
      const waiters = [];
      for (let i = 0; i < 5; i++) {
        waiters.push(await createdWaiter(engine, { match: MATCH("ord_throw") }));
      }
      poisoned = waiters[1]!.id;

      const delivery = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_throw"))),
        120_000
      );

      expect(delivery.status).toBe("FAILED");
      const [summary] = targetsOf(delivery);
      expect(summary).toMatchObject({ id: "waiters", type: "waiter", status: "FAILED" });
      expect(summary?.error).toContain("object store unavailable");
      expect(waitpoints.byId.get(poisoned)?.status).toBe("PENDING");
    } finally {
      await engine.quit();
    }
  },
  150_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "a completion job that throws on every attempt gives up only its chunk, and the delivery still settles",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    let poisoned: string | undefined;
    const waitpoints = makeWaitpoints();
    const ports: WebhookWaitpointPorts = {
      ...waitpoints.ports,
      complete: (args) => {
        if (poisoned && args.waitpointIds.includes(poisoned)) {
          throw new Error("database unavailable");
        }
        return waitpoints.ports.complete(args);
      },
    };
    const engine = buildEngine(prisma, redisOptions, ports, {
      completionChunkSize: 2,
      concurrency: 4,
    });

    try {
      const waiters = [];
      for (let i = 0; i < 5; i++) {
        waiters.push(await createdWaiter(engine, { match: MATCH("ord_chunk_throws") }));
      }
      poisoned = waiters[1]!.id;

      const delivery = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_chunk_throws"))),
        120_000
      );

      const [summary] = targetsOf(delivery);
      expect(summary).toMatchObject({ id: "waiters", type: "waiter", status: "FAILED" });
      expect(delivery.errorMessage).toContain("waiters could not be resumed");
      const completed = waiters.filter((w) => waitpoints.byId.get(w.id)?.status === "COMPLETED");
      expect(waitpoints.byId.get(poisoned)?.status).toBe("PENDING");
      expect(completed.length).toBeGreaterThan(0);
      expect(summary?.waiters).toEqual({
        matched: 5,
        resumed: completed.length,
        failed: 5 - completed.length,
      });
      expect(summary?.error).toContain("database unavailable");
    } finally {
      await engine.quit();
    }
  },
  150_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "an exhausted chunk whose slot release fails once still frees every slot on the retry",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    let poisoned: string | undefined;
    const waitpoints = makeWaitpoints();
    const ports: WebhookWaitpointPorts = {
      ...waitpoints.ports,
      complete: (args) => {
        if (poisoned && args.waitpointIds.includes(poisoned)) {
          throw new Error("database unavailable");
        }
        return waitpoints.ports.complete(args);
      },
    };
    const metrics = inMemoryMetrics();
    const engine = buildEngine(prisma, redisOptions, ports, {
      completionChunkSize: 2,
      concurrency: 4,
      exhaustedRecordDelayMs: 100,
      meter: metrics.meter,
    });
    const store = (engine as unknown as { waiterStore: WebhookWaiterStore }).waiterStore;
    const release = store.releaseEnvironment.bind(store);
    let failedRelease = false;
    store.releaseEnvironment = async (environmentId, members) => {
      if (!failedRelease && poisoned && members.includes(poisoned)) {
        failedRelease = true;
        throw new Error("redis unavailable");
      }
      return release(environmentId, members);
    };

    try {
      const waiters = [];
      for (let i = 0; i < 5; i++) {
        waiters.push(await createdWaiter(engine, { match: MATCH("ord_release_fails") }));
      }
      poisoned = waiters[1]!.id;

      const delivery = await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_release_fails"))),
        120_000
      );

      expect(failedRelease).toBe(true);
      expect(delivery.status).toBe("FAILED");
      expect(await engine.countLiveWaiters("env_test")).toBe(0);
      const resolved = await metrics.points("webhook_waiters_resolved_total");
      const failedCount = resolved.find((p) => p.attributes.result === "failed")?.value ?? 0;
      const resumedCount = resolved.find((p) => p.attributes.result === "resumed")?.value ?? 0;
      expect(failedCount + resumedCount).toBe(5);
      expect(failedCount).toBeGreaterThan(0);
    } finally {
      await engine.quit();
      await metrics.shutdown();
    }
  },
  150_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "waiter creates, claims and resumes are recorded",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const metrics = inMemoryMetrics();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, { meter: metrics.meter });

    try {
      const first = await createdWaiter(engine, {
        match: MATCH("ord_metrics"),
        idempotencyKey: "key_metrics",
      });
      await createdWaiter(engine, { match: MATCH("ord_metrics"), idempotencyKey: "key_metrics" });
      await createdWaiter(engine, { match: MATCH("ord_metrics") });

      await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_metrics")))
      );

      expect(waitpoints.byId.get(first.id)?.status).toBe("COMPLETED");
      expect(await metrics.points("webhook_waiters_created_total")).toEqual([
        { attributes: { outcome: "cached" }, value: 1 },
        { attributes: { outcome: "created" }, value: 2 },
      ]);
      expect(await metrics.points("webhook_waiter_claim_size")).toEqual([
        { attributes: { chunked: false }, value: 1 },
      ]);
      expect(await metrics.points("webhook_waiters_resolved_total")).toEqual([
        { attributes: { result: "resumed" }, value: 2 },
      ]);
    } finally {
      await engine.quit();
      await metrics.shutdown();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "an idempotency key reused on another endpoint or match is refused, leaving the first waiter intact",
  async ({ prisma, redisOptions }) => {
    await createEndpoint(prisma);
    await createEndpoint(prisma, [], "orders-b");
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);
    const create = (over: Partial<Parameters<WebhookEngine["createWaiter"]>[0]>) =>
      engine.createWaiter({
        environmentId: "env_test",
        projectId: "proj_test",
        endpoint: "payments",
        idempotencyKey: "key_reuse",
        ...over,
      });

    try {
      const first = await create({ match: MATCH("ord_reuse") });
      if (first.outcome !== "created") throw new Error(first.outcome);

      expect(await create({ match: MATCH("ord_reuse") })).toMatchObject({
        outcome: "created",
        id: first.id,
        isCached: true,
      });
      expect(await create({ endpoint: "orders-b", match: MATCH("ord_reuse") })).toMatchObject({
        outcome: "invalid",
      });
      expect(await create({ match: MATCH("ord_other") })).toMatchObject({ outcome: "invalid" });

      expect(await engine.cancelWaiter({ environmentId: "env_test", waiterId: first.id })).toEqual({
        outcome: "cancelled",
      });
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a cancel scoped to an endpoint only cancels that endpoint's waiters",
  async ({ prisma, redisOptions }) => {
    const payments = await createEndpoint(prisma);
    const other = await createEndpoint(prisma, [], "orders-b");
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);

    try {
      const waiter = await createdWaiter(engine, { match: MATCH("ord_scoped") });
      expect(
        await engine.cancelWaiter({
          environmentId: "env_test",
          waiterId: waiter.id,
          endpointId: other.id,
        })
      ).toEqual({ outcome: "not_found" });
      expect(waitpoints.byId.get(waiter.id)?.status).toBe("PENDING");
      expect(
        await engine.cancelWaiter({
          environmentId: "env_test",
          waiterId: waiter.id,
          endpointId: payments.id,
        })
      ).toEqual({ outcome: "cancelled" });
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a waiter matching a header still resumes when earlier headers fill the stored header budget",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);

    try {
      const waiter = await createdWaiter(engine, {
        match: { "header.x-tenant-ref": "tenant_42" },
      });
      const request = signed(endpoint.opaqueId, orderEvent("ord_headers"));
      const bulky = Object.fromEntries(
        [1_020, 1_020, 1_020, 978].map((size, i) => [`x-bulky-${i}`, "b".repeat(size)])
      );
      const delivery = await waitForDelivery(
        prisma,
        await accepted(engine, {
          ...request,
          headers: { ...bulky, ...request.headers, "x-tenant-ref": "tenant_42" },
        })
      );

      expect(delivery.status).toBe("SUCCEEDED");
      expect(waitpoints.byId.get(waiter.id)?.status).toBe("COMPLETED");
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "an idempotency key reused after its waiter completed is still checked against the original",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    await createEndpoint(prisma, [], "orders-b");
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);
    const create = (over: Partial<Parameters<WebhookEngine["createWaiter"]>[0]>) =>
      engine.createWaiter({
        environmentId: "env_test",
        projectId: "proj_test",
        endpoint: "payments",
        idempotencyKey: "key_done",
        ...over,
      });

    try {
      const first = await create({ match: MATCH("ord_done") });
      if (first.outcome !== "created") throw new Error(first.outcome);
      await waitForDelivery(
        prisma,
        await accepted(engine, signed(endpoint.opaqueId, orderEvent("ord_done")))
      );
      expect(waitpoints.byId.get(first.id)?.status).toBe("COMPLETED");

      expect(await create({ match: MATCH("ord_done") })).toMatchObject({
        outcome: "created",
        id: first.id,
        isCached: true,
      });
      expect(await create({ endpoint: "orders-b", match: MATCH("ord_done") })).toMatchObject({
        outcome: "invalid",
      });
      expect(await create({ match: MATCH("ord_other") })).toMatchObject({ outcome: "invalid" });
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "headers that live waiters match on are stored even when together they pass the header budget",
  async ({ prisma, redisOptions }) => {
    const endpoint = await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);
    const a = "a".repeat(3_000);
    const b = "b".repeat(3_000);

    try {
      const first = await createdWaiter(engine, { match: { "header.x-ref-a": a } });
      const second = await createdWaiter(engine, { match: { "header.x-ref-b": b } });
      const request = signed(endpoint.opaqueId, orderEvent("ord_two_headers"));
      await waitForDelivery(
        prisma,
        await accepted(engine, {
          ...request,
          headers: { ...request.headers, "x-ref-a": a, "x-ref-b": b },
        })
      );

      expect(waitpoints.byId.get(first.id)?.status).toBe("COMPLETED");
      expect(waitpoints.byId.get(second.id)?.status).toBe("COMPLETED");
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "an idempotency key can't adopt a waitpoint that isn't one of the endpoint's waiters",
  async ({ prisma, redisOptions }) => {
    await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);
    const create = (idempotencyKey: string) =>
      engine.createWaiter({
        environmentId: "env_test",
        projectId: "proj_test",
        endpoint: "payments",
        idempotencyKey,
        match: MATCH("ord_foreign"),
      });

    try {
      const token = await waitpoints.ports.create({
        environmentId: "env_test",
        projectId: "proj_test",
        idempotencyKey: "shared-key",
        timeoutAt: new Date(Date.now() + 60_000),
        tags: [],
      });
      const waiter = await create("shared-key");
      expect(waiter).toMatchObject({ outcome: "created", isCached: false });
      if (waiter.outcome !== "created") throw new Error(waiter.outcome);
      expect(waiter.id).not.toBe(token.id);

      await waitpoints.ports.create({
        environmentId: "env_test",
        projectId: "proj_test",
        idempotencyKey: "webhook-waiter:crafted-key",
        timeoutAt: new Date(Date.now() + 60_000),
        tags: [],
      });
      expect(await create("crafted-key")).toMatchObject({ outcome: "invalid" });

      expect(await engine.cancelWaiter({ environmentId: "env_test", waiterId: token.id })).toEqual({
        outcome: "not_found",
      });
      expect(waitpoints.byId.get(token.id)?.status).toBe("PENDING");
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a reused idempotency key with another filter is refused, since the waiter keeps its first filter",
  async ({ prisma, redisOptions }) => {
    await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports);

    try {
      const first = await createdWaiter(engine, {
        match: MATCH("ord_filter_key"),
        filter: "event.data.object.amount > 100",
        idempotencyKey: "filter-key",
      });
      const same = await createdWaiter(engine, {
        match: MATCH("ord_filter_key"),
        filter: "event.data.object.amount > 100",
        idempotencyKey: "filter-key",
      });
      expect(same.id).toBe(first.id);

      const other = await engine.createWaiter({
        environmentId: "env_test",
        projectId: "proj_test",
        endpoint: "payments",
        match: MATCH("ord_filter_key"),
        filter: "event.data.object.amount > 500",
        idempotencyKey: "filter-key",
      });
      expect(other).toMatchObject({ outcome: "invalid" });
      expect(other.outcome === "invalid" && other.error).toContain("filter");
    } finally {
      await engine.quit();
    }
  }
);

containerTestWithIsolatedRedisNoClickhouse(
  "a waitpoint made outside createWaiter with a waiter's key and tag still takes an environment slot",
  async ({ prisma, redisOptions }) => {
    await createEndpoint(prisma);
    const waitpoints = makeWaitpoints();
    const engine = buildEngine(prisma, redisOptions, waitpoints.ports, {
      limits: { perEnvironment: 1, perEndpoint: 10 },
    });

    try {
      await createdWaiter(engine, { match: MATCH("ord_slot_1") });
      await waitpoints.ports.create({
        environmentId: "env_test",
        projectId: "proj_test",
        idempotencyKey: "webhook-waiter:adopted",
        timeoutAt: new Date(Date.now() + 60_000),
        tags: ["webhook:payments"],
      });

      const adopted = await engine.createWaiter({
        environmentId: "env_test",
        projectId: "proj_test",
        endpoint: "payments",
        match: MATCH("ord_slot_2"),
        idempotencyKey: "adopted",
      });
      expect(adopted).toMatchObject({ outcome: "limit", reason: "environment_limit" });
    } finally {
      await engine.quit();
    }
  }
);
