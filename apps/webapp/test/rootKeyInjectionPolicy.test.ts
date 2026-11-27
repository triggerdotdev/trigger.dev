import { containerTest } from "@internal/testcontainers";
import { RunEngine } from "@internal/run-engine";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { trace } from "@opentelemetry/api";
import { expect, onTestFinished, vi } from "vitest";
import { FEATURE_FLAG } from "~/v3/featureFlags";

vi.setConfig({ testTimeout: 60_000 });

containerTest(
  "requires run-token delivery when automatic root key injection is disabled",
  async ({ prisma, redisOptions, postgresContainer }) => {
    const url = postgresContainer.getConnectionUri();
    process.env.DATABASE_URL = url;
    process.env.DIRECT_URL = url;
    delete process.env.DATABASE_READ_REPLICA_URL;
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
    process.env.RUN_TOKEN_ISSUER_URL = "https://internal-runs.example.com";
    const { AuthenticatedWorkerInstance } =
      await import("~/v3/services/worker/workerGroupTokenService.server");
    const { internalRunSigningService } = await import("~/services/oidc/instance.server");
    const engine = new RunEngine({
      prisma,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
      runLock: { redis: redisOptions },
      machines: {
        defaultMachine: "small-1x",
        machines: { "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
        baseCostInCents: 0.0001,
      },
      tracer: trace.getTracer("root-key-injection-test"),
    });
    onTestFinished(() => engine.quit());
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    await prisma.organization.update({
      where: { id: environment.organizationId },
      data: {
        featureFlags: { [FEATURE_FLAG.runTokenInjection]: false },
      },
    });
    await setupBackgroundWorker(engine, environment, ["legacy", "signing-failure", "strict"]);
    const worker = new AuthenticatedWorkerInstance({
      prisma,
      engine,
      type: "MANAGED",
      name: "test-workers",
      workerGroupId: "test-workers",
      workerInstanceId: "test-worker",
      masterQueue: "main",
      region: null,
      workloadType: "MICROVM",
      allowedSubscriptions: [],
    });

    async function dequeue(task: string, number: number) {
      const run = await engine.trigger(
        {
          number,
          friendlyId: RunId.generate().friendlyId,
          environment,
          taskIdentifier: task,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: task,
          spanId: task,
          workerQueue: "main",
          queue: `task/${task}`,
          isTest: false,
          tags: [],
        },
        prisma
      );
      return vi.waitFor(
        async () => {
          await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
          const [message] = await engine.dequeueFromWorkerQueue({
            consumerId: task,
            workerQueue: "main",
          });
          expect(message?.run.friendlyId).toBe(run.friendlyId);
          return {
            runFriendlyId: run.friendlyId,
            snapshotFriendlyId: message!.snapshot.friendlyId,
            environmentId: environment.id,
            supportsRunTokenRefresh: true,
            supportsUsageJwtRefresh: true,
            supportsRootKeyFreeExecution: true,
          };
        },
        { timeout: 10_000 }
      );
    }

    const legacy = await worker.startRunAttempt(await dequeue("legacy", 1));
    expect(legacy.envVars.TRIGGER_SECRET_KEY).toBeTruthy();
    expect(legacy.envVars.TRIGGER_RUN_TOKEN).toBeUndefined();

    await prisma.runtimeEnvironment.update({
      where: { id: environment.id },
      data: { rootKeyInjectionDisabledAt: new Date() },
    });
    const strict = await dequeue("strict", 2);
    await expect(
      worker.startRunAttempt({ ...strict, supportsRootKeyFreeExecution: false })
    ).rejects.toMatchObject({ status: 503 });
    await expect(worker.startRunAttempt(strict)).rejects.toMatchObject({ status: 503 });
    const afterFailure = await engine.runStore.findRunOnPrimary(
      { friendlyId: strict.runFriendlyId },
      { select: { status: true } }
    );
    expect(afterFailure?.status).not.toBe("EXECUTING");

    const key = await internalRunSigningService.generateStagedKey("root-key-injection-test");
    await prisma.oidcSigningKey.update({ where: { id: key.id }, data: { readyAt: new Date(0) } });
    await internalRunSigningService.activateKey(key.id, "root-key-injection-test");
    const next = await dequeue("signing-failure", 3);
    const started = await worker.startRunAttempt(next);
    expect(started.requiresRunToken).toBe(true);
    expect(started.envVars).not.toHaveProperty("TRIGGER_SECRET_KEY");
    expect(started.envVars.TRIGGER_RUN_TOKEN).toBeTruthy();

    // The best-effort flag is off, but a strict attempt must still be able to renew.
    const refreshed = await worker.heartbeatRun({
      ...next,
      snapshotFriendlyId: started.snapshot.friendlyId,
      runTokenReport: { expiresAt: 0, trigger: "heartbeat" },
    });
    expect(refreshed.runToken).toBeTruthy();
  }
);
