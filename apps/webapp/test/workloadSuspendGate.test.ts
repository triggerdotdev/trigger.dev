import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { trace } from "@opentelemetry/api";
import { expect, onTestFinished, vi } from "vitest";
import { AuthenticatedWorkerInstance } from "~/v3/services/worker/workerGroupTokenService.server";

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test",
    DIRECT_URL: "postgresql://postgres:postgres@localhost:5432/test",
    MAGIC_LINK_SECRET: "test-magic-link-secret",
    ENCRYPTION_KEY: "test-encryption-key-for-e2e!!!!!",
    DEPLOY_REGISTRY_HOST: "registry.example.com",
    V4_DEPLOY_REGISTRY_HOST: "registry.example.com",
    CLICKHOUSE_URL: "http://localhost:8123",
  });
  process.env.WORKLOAD_CREATED_AT_GATE_ENABLED = "1";
  process.env.WORKLOAD_TOKEN_CUTOFF = "2026-09-01T00:00:00.000Z";
});

vi.setConfig({ testTimeout: 60_000 });

// Catches: unscoped suspend authorization or rejecting legitimate post-cutoff requests.
containerTest(
  "gates suspend preflight while restore heartbeats and legacy completion remain compatible",
  async ({ prisma, redisOptions }) => {
    const engine = new RunEngine({
      prisma,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
      runLock: { redis: redisOptions },
      machines: {
        defaultMachine: "small-1x",
        machines: {
          "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
        },
        baseCostInCents: 0.0005,
      },
      tracer: trace.getTracer("workload-suspend-gate"),
    });
    onTestFinished(() => engine.quit());
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const foreignOrg = await prisma.organization.create({
      data: { title: "Foreign", slug: "foreign" },
    });
    const foreignProject = await prisma.project.create({
      data: {
        name: "Foreign",
        slug: "foreign",
        externalRef: "proj_foreign",
        organizationId: foreignOrg.id,
      },
    });
    const foreignEnvironment = await prisma.runtimeEnvironment.create({
      data: {
        type: "PRODUCTION",
        slug: "foreign",
        projectId: foreignProject.id,
        organizationId: foreignOrg.id,
        apiKey: "foreign-api-key",
        pkApiKey: "foreign-pk",
        shortcode: "foreign",
      },
    });
    await setupBackgroundWorker(engine, environment, "suspend-gate");
    const worker = new AuthenticatedWorkerInstance({
      prisma,
      engine,
      type: "MANAGED",
      name: "gate-test",
      workerGroupId: "gate-group",
      workerInstanceId: "gate-worker",
      masterQueue: "main",
      region: null,
      workloadType: "CONTAINER",
      allowedSubscriptions: [],
    });
    const run = await engine.trigger(
      {
        number: 1,
        friendlyId: "run_suspendgate",
        environment,
        taskIdentifier: "suspend-gate",
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: "suspend-gate",
        spanId: "suspend-gate",
        workerQueue: "main",
        queue: "task/suspend-gate",
        isTest: false,
        tags: [],
      },
      prisma
    );
    await prisma.taskRun.update({
      where: { id: run.id },
      data: { createdAt: new Date("2026-09-02T00:00:00.000Z") },
    });
    const execution = await engine.getRunExecutionData({ runId: run.id });
    assertNonNullable(execution);
    const params = {
      runFriendlyId: run.friendlyId,
      snapshotFriendlyId: execution.snapshot.friendlyId,
    };

    await expect(worker.authorizeSuspend(run.friendlyId)).rejects.toMatchObject({ status: 403 });

    // A current runner's verified environment must survive dispatch, even for post-cutoff runs.
    await expect(worker.authorizeSuspend(run.friendlyId, environment.id)).resolves.toBe(
      environment.id
    );
    await expect(
      worker.heartbeatRun({ ...params, environmentId: environment.id })
    ).resolves.toEqual({});
    await expect(
      worker.authorizeSuspend(run.friendlyId, foreignEnvironment.id)
    ).rejects.toMatchObject({ status: 403 });

    await prisma.taskRun.update({
      where: { id: run.id },
      data: { createdAt: new Date("2026-09-01T00:00:00.000Z") },
    });
    await expect(worker.authorizeSuspend(run.friendlyId)).resolves.toBe(environment.id);
    await expect(worker.heartbeatRun(params)).resolves.toEqual({});

    await prisma.taskRun.update({
      where: { id: run.id },
      data: { createdAt: new Date("2026-09-02T00:00:00.000Z") },
    });
    const dequeue = async () =>
      vi.waitFor(
        async () => {
          const messages = await engine.dequeueFromWorkerQueue({
            consumerId: "gate-test",
            workerQueue: "main",
          });
          expect(messages).toHaveLength(1);
          return messages[0]!;
        },
        { timeout: 5_000 }
      );
    const message = await dequeue();
    await engine.startRunAttempt({ runId: run.id, snapshotId: message.snapshot.id });
    const { waitpoint } = await engine.createManualWaitpoint({
      environmentId: environment.id,
      projectId: environment.projectId,
    });
    const blocked = await engine.blockRunWithWaitpoint({
      runId: run.id,
      waitpoints: waitpoint.id,
      projectId: environment.projectId,
      organizationId: environment.organizationId,
    });
    await worker.authorizeSuspend(run.friendlyId, environment.id);
    // Catches: deploying the webapp before old reporters upgrade must not lose completed snapshots.
    const checkpoint = await worker.createCheckpoint({
      runFriendlyId: run.friendlyId,
      snapshotFriendlyId: blocked.friendlyId,
      checkpoint: { type: "COMPUTE", location: "node/snapshot" },
    });
    expect(checkpoint.ok).toBe(true);
    await engine.completeWaitpoint({ id: waitpoint.id });
    const restored = await dequeue();
    await expect(
      worker.heartbeatRun({
        runFriendlyId: run.friendlyId,
        snapshotFriendlyId: restored.snapshot.friendlyId,
      })
    ).resolves.toEqual({});
    const continued = await worker.continueRunExecution({
      runFriendlyId: run.friendlyId,
      snapshotFriendlyId: restored.snapshot.friendlyId,
      environmentId: environment.id,
    });
    expect(continued.snapshot.executionStatus).toBe("EXECUTING");
  }
);
