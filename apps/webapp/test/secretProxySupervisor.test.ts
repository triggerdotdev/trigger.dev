import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { assertNonNullable, postgresAndRedisTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { RunId, SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import {
  SupervisorHttpClient,
  WorkerApiRunAttemptCompleteRequestBody,
  WORKLOAD_HEADERS,
} from "@trigger.dev/core/v3/workers";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Registry } from "prom-client";
import { afterAll, beforeAll, expect, onTestFinished, vi } from "vitest";
import { SecretProxyFixture } from "../../supervisor/src/services/fixtures/secretProxy.js";
import {
  SecretProxyBindings,
  reportSecretProxyRestoreRefusal,
} from "../../supervisor/src/services/secretProxyBindings.js";
import { RunReleaser } from "../../supervisor/src/services/runReleases.js";
import { WorkloadServer } from "../../supervisor/src/workloadServer/index.js";
import { mintDeploymentToken } from "../../supervisor/src/workloadToken.js";

vi.hoisted(() => {
  Object.assign(process.env, {
    TRIGGER_API_URL: "http://127.0.0.1:3030",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
    TRIGGER_WORKER_TOKEN: "test-supervisor-token",
    MANAGED_WORKER_SECRET: "test-supervisor-secret",
    WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
    WORKLOAD_TOKEN_SECRET: "secret-proxy-lifecycle-test-signing-key",
  });
});
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const machines = {
  defaultMachine: "small-1x" as const,
  machines: {
    "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
  },
  baseCostInCents: 0.0005,
};
const fixture = new SecretProxyFixture();
beforeAll(() => fixture.start(), 600_000);
afterAll(() => fixture.stop(), 60_000);

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

// The HTTP boundary invokes the real engine; only restore-report availability is fault-injected.
async function engineBoundary(
  engine: RunEngine,
  environmentId: string,
  reportStatus: () => number = () => 503
) {
  const server = createServer((req, res) => {
    void (async () => {
      const match = req.url?.match(/\/runs\/([^/]+)\/snapshots\/([^/]+)\/(.+)$/);
      if (!match) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const runId = RunId.fromFriendlyId(match[1]!);
      const snapshotId = SnapshotId.fromFriendlyId(match[2]!);
      res.setHeader("content-type", "application/json");
      if (match[3] === "restore-outcome") {
        res.setHeader("x-should-retry", "false");
        res.writeHead(reportStatus()).end(JSON.stringify({ error: "report unavailable" }));
      } else if (match[3] === "release") {
        const released = await engine.releaseRun({
          runId,
          snapshotId,
          environmentId,
          reason: body.reason,
        });
        res.writeHead(released.ok ? 200 : 409).end(JSON.stringify(released));
      } else if (match[3] === "attempts/complete") {
        const input = WorkerApiRunAttemptCompleteRequestBody.parse(body);
        const result = await engine.completeRunAttempt({
          runId,
          snapshotId,
          environmentId,
          ...input,
          runnerId: req.headers[WORKLOAD_HEADERS.RUNNER_ID] as string | undefined,
        });
        res.end(JSON.stringify({ result }));
      } else res.writeHead(404).end();
    })().catch((error) => res.writeHead(500).end(JSON.stringify({ error: String(error) })));
  });
  const port = await listen(server);
  onTestFinished(() => close(server));
  return new SupervisorHttpClient({
    apiUrl: `http://127.0.0.1:${port}`,
    workerToken: "test-worker",
    instanceName: "test-supervisor",
  });
}

function bindings() {
  const value = new SecretProxyBindings({
    k8s: { core: fixture.core, custom: fixture.custom },
    namespace: fixture.namespace,
    nodeName: fixture.nodeName,
    socketPath: fixture.socketPath,
  });
  onTestFinished(() => value.stop());
  return value;
}

postgresAndRedisTest(
  "cold-only supervisor retries use a fresh allocation regardless of image flags",
  async ({ prisma, redisOptions }) => {
    const engine = new RunEngine({
      prisma,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
      runLock: { redis: redisOptions },
      machines,
      tracer: trace.getTracer("secret-proxy-retries"),
    });
    onTestFinished(() => engine.quit());
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    await setupBackgroundWorker(engine, environment, "cold-retry");
    const client = await engineBoundary(engine, environment.id);
    const token = await mintDeploymentToken({
      deployment: "deployment_test",
      deployment_version: "1",
      environment_id: environment.id,
      environment_type: "PRODUCTION",
      org_id: environment.organizationId,
      project_id: environment.projectId,
    });
    assertNonNullable(token);

    for (const [index, options] of [
      { cold: true },
      { cold: true, forceRequeue: false },
      { cold: false },
    ].entries()) {
      const workerQueue = `cold-retry-${index}`;
      const run = await engine.trigger(
        {
          number: index + 1,
          friendlyId: `run_coldretry${index}`,
          environment,
          taskIdentifier: "cold-retry",
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: `retry-${index}`,
          spanId: `retry-${index}`,
          workerQueue,
          queue: "task/cold-retry",
          isTest: false,
          tags: [],
        },
        prisma
      );
      let dequeued: Awaited<ReturnType<RunEngine["dequeueFromWorkerQueue"]>>[number] | undefined;
      await expect
        .poll(
          async () => {
            dequeued = (
              await engine.dequeueFromWorkerQueue({ consumerId: "test", workerQueue })
            )[0];
            return !!dequeued;
          },
          { timeout: 10_000, interval: 100 }
        )
        .toBe(true);
      assertNonNullable(dequeued);
      const runnerId = `runner-coldretry${index}`;
      const started = await engine.startRunAttempt({
        runId: run.id,
        snapshotId: dequeued.snapshot.id,
        runnerId,
      });
      const portReservation = createServer();
      const port = await listen(portReservation);
      await close(portReservation);
      const server = new WorkloadServer({
        port,
        host: "127.0.0.1",
        workerClient: client,
        secretProxy: options.cold ? bindings() : undefined,
        wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
        wideEventsNoisyRoutes: false,
      });
      await server.start();
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/v1/workload-actions/runs/${run.friendlyId}/snapshots/${started.snapshot.friendlyId}/attempts/complete`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [WORKLOAD_HEADERS.RUNNER_ID]: runnerId,
              [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
            },
            body: JSON.stringify({
              ...("forceRequeue" in options ? { forceRequeue: options.forceRequeue } : {}),
              completion: {
                ok: false,
                id: run.friendlyId,
                error: { type: "BUILT_IN_ERROR", name: "Error", message: "retry", stackTrace: "" },
                retry: { delay: 100, timestamp: Date.now() + 100 },
              },
            }),
          }
        );
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.result.attemptStatus).toBe(
          options.cold ? "RETRY_QUEUED" : "RETRY_IMMEDIATELY"
        );
        const persisted = await engine.getRunExecutionData({ runId: run.id });
        expect(persisted?.snapshot.executionStatus).toBe(options.cold ? "QUEUED" : "EXECUTING");
      } finally {
        await server.stop();
      }
    }
  }
);

postgresAndRedisTest(
  "failed checkpoint refusal reports requeue while preserving the checkpoint",
  async ({ prisma, redisOptions }) => {
    const engine = new RunEngine({
      prisma,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
      runLock: { redis: redisOptions },
      machines,
      tracer: trace.getTracer("secret-proxy-restore-report"),
    });
    onTestFinished(() => engine.quit());
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    await setupBackgroundWorker(engine, environment, "checkpoint-refusal");
    let reportStatus = 503;
    const client = await engineBoundary(engine, environment.id, () => reportStatus);
    const run = await engine.trigger(
      {
        number: 1,
        friendlyId: "run_restorefailure",
        environment,
        taskIdentifier: "checkpoint-refusal",
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: "restore-failure",
        spanId: "restore-failure",
        workerQueue: "restore-failure",
        queue: "task/checkpoint-refusal",
        isTest: false,
        tags: [],
      },
      prisma
    );
    let dequeued: Awaited<ReturnType<RunEngine["dequeueFromWorkerQueue"]>>[number] | undefined;
    await expect
      .poll(
        async () => {
          dequeued = (
            await engine.dequeueFromWorkerQueue({
              consumerId: "test",
              workerQueue: "restore-failure",
            })
          )[0];
          return !!dequeued;
        },
        { timeout: 10_000, interval: 100 }
      )
      .toBe(true);
    assertNonNullable(dequeued);
    const checkpoint = await prisma.taskRunCheckpoint.create({
      data: {
        friendlyId: "checkpoint_before_enrollment",
        type: "COMPUTE",
        location: "saved",
        projectId: environment.projectId,
        runtimeEnvironmentId: environment.id,
      },
    });
    await prisma.taskRunExecutionSnapshot.update({
      where: { id: dequeued.snapshot.id },
      data: { checkpointId: checkpoint.id },
    });
    const releaser = new RunReleaser({
      client: () => client,
      register: new Registry(),
      runsReleasedAMinute: 10,
    });
    const options = { interceptorSocket: fixture.socketPath, checkpoint };
    const deps = {
      report: (body: Parameters<SupervisorHttpClient["reportRestoreOutcome"]>[2]) =>
        client.reportRestoreOutcome(run.friendlyId, dequeued!.snapshot.friendlyId, body),
      release: () =>
        releaser.release(
          {
            runFriendlyId: run.friendlyId,
            snapshotFriendlyId: dequeued!.snapshot.friendlyId,
            runnerId: "runner-restorefailure",
            environmentId: environment.id,
          },
          "RestoreRefusalFailed"
        ),
    };
    expect(await reportSecretProxyRestoreRefusal(options, deps)).toMatchObject({
      result: "error",
      releaseResult: "released",
    });
    const persisted = await engine.getRunExecutionData({ runId: run.id });
    expect(persisted?.snapshot.executionStatus).toBe("QUEUED");
    assertNonNullable(persisted);
    const snapshot = await prisma.taskRunExecutionSnapshot.findUniqueOrThrow({
      where: { id: persisted.snapshot.id },
    });
    expect(snapshot.checkpointId).toBe(checkpoint.id);

    reportStatus = 409;
    const conflict = await reportSecretProxyRestoreRefusal(options, {
      ...deps,
      release: async () => {
        throw new Error("A stale report must not release a newer snapshot");
      },
    });
    expect(conflict).toEqual({ result: "conflict" });
  }
);
