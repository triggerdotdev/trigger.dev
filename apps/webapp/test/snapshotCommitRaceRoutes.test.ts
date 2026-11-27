// A latest-snapshot read that races a snapshot commit is harmless and must not log an error; other
// retriable reasons may not clear on retry and must. Real routes, engine, Postgres and Redis.
import { containerTest } from "@internal/testcontainers";
import { createCompletedWaitpointResolver, RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import {
  PostgresRunStore,
  preparedUnitKey,
  type RecoveryOutcome,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
} from "@internal/run-store";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Redis } from "ioredis";
import { setTimeout } from "node:timers/promises";
import { expect, onTestFinished, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ engine: undefined as unknown }));
vi.mock("~/v3/runEngine.server", () => ({
  get engine() {
    return hoisted.engine;
  },
}));

vi.setConfig({ testTimeout: 90_000 });

const MANAGED_WORKER_SECRET = "test-managed-worker-secret";
const taskIdentifier = "snapshot-race";

containerTest(
  "a read during a pending-unit commit answers 503 without an error log; other retriable reasons still log an error",
  async ({ prisma, redisOptions, postgresContainer }) => {
    Object.assign(process.env, {
      DATABASE_URL: postgresContainer.getConnectionUri(),
      DIRECT_URL: postgresContainer.getConnectionUri(),
      REDIS_HOST: redisOptions.host,
      REDIS_PORT: String(redisOptions.port),
      REDIS_TLS_DISABLED: "true",
      MAGIC_LINK_SECRET: "test-magic-link-secret",
      ENCRYPTION_KEY: "test-encryption-key-for-e2e!!!!!",
      MANAGED_WORKER_SECRET,
      DEPLOY_REGISTRY_HOST: "registry.example.com",
      V4_DEPLOY_REGISTRY_HOST: "registry.example.com",
      CLICKHOUSE_URL: "http://localhost:8123",
    });
    delete process.env.DATABASE_READ_REPLICA_URL;

    let outcome: RecoveryOutcome | undefined;
    const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const engine = new RunEngine({
      prisma,
      store: new TaskRunExecutionSnapshotStore(delegate, {
        store: new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 }),
        mode: "redis-only",
        logicalRunStoreRoute: "logical:1",
        resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
        // Recovery leaves the unit prepared and reports why, as it does mid-commit.
        resolvePending: async () => outcome,
      }),
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
      runLock: { redis: redisOptions },
      machines: {
        defaultMachine: "small-1x",
        machines: { "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
        baseCostInCents: 0.0001,
      },
      tracer: trace.getTracer("snapshot-commit-race"),
    });
    onTestFinished(() => engine.quit());
    hoisted.engine = engine;

    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    await setupBackgroundWorker(engine, env, taskIdentifier);
    const run = await engine.trigger(
      {
        number: 1,
        friendlyId: "run_heartbeatrace1",
        environment: env,
        taskIdentifier,
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: "t-heartbeatrace1",
        spanId: "s-heartbeatrace1",
        workerQueue: "main",
        queue: `task/${taskIdentifier}`,
        isTest: false,
        tags: [],
      },
      prisma
    );
    let attempt: Awaited<ReturnType<RunEngine["startRunAttempt"]>> | undefined;
    const deadline = performance.now() + 10_000;
    while (!attempt && performance.now() < deadline) {
      await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
      const [dequeued] = await engine.dequeueFromWorkerQueue({
        consumerId: "test_heartbeatrace",
        workerQueue: "main",
      });
      if (dequeued) {
        attempt = await engine.startRunAttempt({ runId: run.id, snapshotId: dequeued.snapshot.id });
      } else {
        await setTimeout(50);
      }
    }
    if (!attempt) throw new Error("run never reached the worker queue");

    const { WorkerGroupTokenService } =
      await import("~/v3/services/worker/workerGroupTokenService.server");
    const token = await new WorkerGroupTokenService({ prisma, engine }).createToken();
    await prisma.workerInstanceGroup.create({
      data: { type: "MANAGED", name: "snapshot-race", masterQueue: "main", tokenId: token.id },
    });
    const { action: heartbeatAction } =
      await import("~/routes/engine.v1.worker-actions.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.heartbeat");
    const { loader: latestLoader } =
      await import("~/routes/engine.v1.worker-actions.runs.$runFriendlyId.snapshots.latest");
    const { loader: outputLoader } =
      await import("~/routes/api.v1.runs.$runId.waitpoints.$waitpointId.output");
    const { loader: devLatestLoader } =
      await import("~/routes/engine.v1.dev.runs.$runFriendlyId.snapshots.latest");
    const { action: devHeartbeatAction } =
      await import("~/routes/engine.v1.dev.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.heartbeat");

    const devEnv = await prisma.runtimeEnvironment.create({
      data: {
        type: "DEVELOPMENT",
        slug: "dev",
        projectId: env.projectId,
        organizationId: env.organizationId,
        apiKey: "tr_dev_snapshotrace",
        pkApiKey: "pk_dev_snapshotrace",
        shortcode: "dev_short",
        maximumConcurrencyLimit: 10,
      },
      include: { project: true, organization: true, orgMember: true },
    });
    const devRun = await engine.trigger(
      {
        number: 2,
        friendlyId: "run_heartbeatrace2",
        environment: devEnv,
        taskIdentifier,
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: "t-heartbeatrace2",
        spanId: "s-heartbeatrace2",
        workerQueue: "main",
        queue: `task/${taskIdentifier}`,
        isTest: false,
        tags: [],
      },
      prisma
    );

    const errorLogs: Record<string, unknown>[] = [];
    const previousOnLog = Logger.onLog;
    Logger.onLog = (log) => {
      if (log.level === "error") errorLogs.push(log);
    };
    onTestFinished(() => {
      Logger.onLog = previousOnLog;
    });
    const loggedError = (message: string) =>
      errorLogs.some(
        (log) => log.message === message && JSON.stringify(log).includes("route-unavailable")
      );

    const redis = new Redis(redisOptions);
    onTestFinished(() => redis.quit());
    await redis.hset(preparedUnitKey(run.id), "unit", "{}");
    await redis.hset(preparedUnitKey(devRun.id), "unit", "{}");

    const workerHeaders = {
      Authorization: `Bearer ${token.plaintext}`,
      "x-trigger-worker-instance-name": "snapshot-race",
      "x-trigger-worker-managed-secret": MANAGED_WORKER_SECRET,
      "content-type": "application/json",
    };
    const snapshotFriendlyId = attempt.snapshot.friendlyId;
    const heartbeat = () =>
      heartbeatAction({
        request: new Request(
          `http://localhost/engine/v1/worker-actions/runs/${run.friendlyId}/snapshots/${snapshotFriendlyId}/heartbeat`,
          { method: "POST", headers: workerHeaders, body: "{}" }
        ),
        params: { runFriendlyId: run.friendlyId, snapshotFriendlyId },
        context: {},
      });
    const latest = () =>
      latestLoader({
        request: new Request(
          `http://localhost/engine/v1/worker-actions/runs/${run.friendlyId}/snapshots/latest`,
          { headers: workerHeaders }
        ),
        params: { runFriendlyId: run.friendlyId },
        context: {},
      });
    const output = () =>
      outputLoader({
        request: new Request(
          `http://localhost/api/v1/runs/${run.friendlyId}/waitpoints/waitpoint_race/output`,
          { headers: { Authorization: `Bearer ${env.apiKey}` } }
        ),
        params: { runId: run.friendlyId, waitpointId: "waitpoint_race" },
        context: {},
      });

    const devHeaders = { Authorization: `Bearer ${devEnv.apiKey}` };
    const devLatest = () =>
      devLatestLoader({
        request: new Request(
          `http://localhost/engine/v1/dev/runs/${devRun.friendlyId}/snapshots/latest`,
          { headers: devHeaders }
        ),
        params: { runFriendlyId: devRun.friendlyId },
        context: {},
      });
    const devHeartbeat = () =>
      devHeartbeatAction({
        request: new Request(
          `http://localhost/engine/v1/dev/runs/${devRun.friendlyId}/snapshots/${snapshotFriendlyId}/heartbeat`,
          { method: "POST", headers: devHeaders }
        ),
        params: { runFriendlyId: devRun.friendlyId, snapshotFriendlyId },
        context: {},
      });

    outcome = { kind: "retry", runId: run.id, reason: "in-progress" };
    expect((await heartbeat()).status).toBe(503);
    expect((await latest()).status).toBe(503);
    expect((await output()).status).toBe(503);
    expect((await devLatest()).status).toBe(503);
    expect((await devHeartbeat()).status).toBe(503);
    expect(errorLogs).toEqual([]);

    outcome = { kind: "retry", runId: run.id, reason: "route-unavailable" };
    expect((await heartbeat()).status).toBe(500);
    expect(loggedError("Error in action")).toBe(true);
    expect((await latest()).status).toBe(500);
    expect(loggedError("Failed to getRunExecutionData")).toBe(true);
  }
);
