import { containerTest } from "@internal/testcontainers";
import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { trace } from "@opentelemetry/api";
import { sandboxExecutionPolicy } from "@trigger.dev/core/v3";
import { expect, onTestFinished, vi } from "vitest";
import { FEATURE_FLAG } from "~/v3/featureFlags";

vi.setConfig({ testTimeout: 60_000 });

// Catches: a standard or warm runner that knows a sandbox run's ids starting it with full access.
containerTest(
  "a policy run starts only for its own verified sandbox token",
  async ({ prisma, redisOptions, postgresContainer }) => {
    const url = postgresContainer.getConnectionUri();
    process.env.DATABASE_URL = url;
    process.env.DIRECT_URL = url;
    delete process.env.DATABASE_READ_REPLICA_URL;
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
    process.env.RUN_TOKEN_ISSUER_URL = "https://internal-runs.example.com";
    const { AuthenticatedWorkerInstance } =
      await import("~/v3/services/worker/workerGroupTokenService.server");
    // Policy runs fail closed without a run token, so signing must be available.
    const { internalRunSigningService } = await import("~/services/oidc/instance.server");
    const signingKey = await internalRunSigningService.generateStagedKey("policy-test");
    await prisma.oidcSigningKey.update({
      where: { id: signingKey.id },
      data: { readyAt: new Date(0) },
    });
    await internalRunSigningService.activateKey(signingKey.id, "policy-test");

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
        baseCostInCents: 0.0001,
      },
      tracer: trace.getTracer("policy-run-attempt-start"),
    });
    onTestFinished(() => engine.quit());
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    await prisma.organization.update({
      where: { id: environment.organizationId },
      data: { featureFlags: { [FEATURE_FLAG.runTokenInjection]: true } },
    });
    await setupBackgroundWorker(engine, environment, "policy-test");

    const run = await engine.trigger(
      {
        number: 1,
        friendlyId: "run_policystart",
        environment,
        taskIdentifier: "policy-test",
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: "policy-test",
        spanId: "policy-test",
        workerQueue: "main",
        queue: "task/policy-test",
        isTest: false,
        tags: [],
        annotations: {
          triggerSource: "api",
          triggerAction: "trigger",
          rootTriggerSource: "api",
          executionMode: "SANDBOX",
          executionPolicy: sandboxExecutionPolicy({}),
        },
      },
      prisma
    );
    const message = await vi.waitFor(
      async () => {
        await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
        const [dequeued] = await engine.dequeueFromWorkerQueue({
          consumerId: "policy-test",
          workerQueue: "main",
        });
        expect(dequeued).toBeDefined();
        return dequeued!;
      },
      { timeout: 10_000 }
    );

    const worker = new AuthenticatedWorkerInstance({
      prisma,
      engine,
      type: "MANAGED",
      name: "policy-test",
      workerGroupId: "policy-test",
      workerInstanceId: "policy-test",
      masterQueue: "main",
      region: null,
      workloadType: "MICROVM",
      allowedSubscriptions: [],
    });
    const start = (sandboxRunId: string | undefined) =>
      worker.startRunAttempt({
        runFriendlyId: run.friendlyId,
        snapshotFriendlyId: message.snapshot.friendlyId,
        environmentId: environment.id,
        sandboxRunId,
        supportsRunTokenRefresh: true,
      });

    for (const sandboxRunId of [undefined, "run_other"]) {
      await expect(start(sandboxRunId)).rejects.toMatchObject({ status: 409 });
    }
    const started = await start(run.friendlyId);
    expect(started.run.attemptNumber).toBe(1);
    expect(started.envVars.TRIGGER_RUN_TOKEN).toBeDefined();
  }
);
