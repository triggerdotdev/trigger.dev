import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { WORKER_HEADERS } from "@trigger.dev/core/v3/workers";
import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { trace } from "@opentelemetry/api";
import { $transaction, type PrismaReplicaClient } from "@trigger.dev/database";
import { expect, onTestFinished, vi } from "vitest";
import { resolveEncryptionKeyring } from "~/utils/encryptionKeyring.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

const FAILURE_CACHE_EXPIRY_MS = 1_100;
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
const MANAGED_WORKER_SECRET = "worker-project-scope-test";
const keyring = resolveEncryptionKeyring(undefined, ENCRYPTION_KEY);

// Catches: an unavailable environment key consuming a customer attempt or failing the run.
containerTest(
  "an unavailable environment key leaves the run startable once access is restored",
  async ({ prisma, redisOptions, postgresContainer }) => {
    // The production worker path reads through the webapp's own clients.
    const url = postgresContainer.getConnectionUri();
    process.env.DATABASE_URL = url;
    process.env.DIRECT_URL = url;
    delete process.env.DATABASE_READ_REPLICA_URL;
    // The production service must share the keyring used to write the test secret.
    process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
    process.env.MANAGED_WORKER_SECRET = MANAGED_WORKER_SECRET;
    delete process.env.ENCRYPTION_KEYRING;
    const { EnvironmentEncryptionService } =
      await import("~/services/environmentEncryption/service.server");
    const { EnvironmentVariablesRepository } =
      await import("~/v3/environmentVariables/environmentVariablesRepository.server");
    const { AuthenticatedWorkerInstance, WorkerGroupTokenService } =
      await import("~/v3/services/worker/workerGroupTokenService.server");

    const engineOptions = {
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
      tracer: trace.getTracer("environment-key-attempt-start"),
    } satisfies ConstructorParameters<typeof RunEngine>[0];
    const engine = new RunEngine(engineOptions);
    onTestFinished(() => engine.quit());
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    await prisma.organization.update({
      where: { id: environment.organizationId },
      data: { featureFlags: { [FEATURE_FLAG.environmentEncryptionEnabled]: true } },
    });
    await setupBackgroundWorker(engine, environment, "key-test");

    const encryption = new EnvironmentEncryptionService({
      db: prisma,
      transaction: (fn) => $transaction(prisma, fn),
      keyring,
      writesEnabled: true,
      defaultWrappingPolicy: {
        wrappingProvider: "PLATFORM_KEYRING",
        wrappingKeyReference: keyring.activeKeyId,
      },
    });
    await expect(
      new EnvironmentVariablesRepository(prisma, prisma, encryption).create(environment.projectId, {
        override: true,
        environmentIds: [environment.id],
        variables: [{ key: "CUSTOMER_SECRET", value: "secret" }],
      })
    ).resolves.toEqual({ success: true });
    const key = await prisma.environmentEncryptionKey.findFirstOrThrow({
      where: { environmentId: environment.id },
    });

    let releaseStaleRead!: () => void;
    const staleReadReleased = new Promise<void>((resolve) => (releaseStaleRead = resolve));
    let staleReader!: (reader: PrismaReplicaClient) => void;
    const staleReaderReady = new Promise<PrismaReplicaClient>((resolve) => (staleReader = resolve));
    // A replica that has not yet replayed the trigger: its snapshot predates the run.
    const staleRead = $transaction(
      prisma,
      async (tx) => {
        await tx.taskRun.findFirst({ select: { id: true } });
        staleReader(tx as unknown as PrismaReplicaClient);
        await staleReadReleased;
      },
      () => {},
      { isolationLevel: "RepeatableRead", timeout: 60_000 }
    );
    const staleRunReader = await staleReaderReady;

    const triggerAndDequeue = async (number: number) => {
      const run = await engine.trigger(
        {
          number,
          friendlyId: `run_keyunavailable${number}`,
          environment,
          taskIdentifier: "key-test",
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "key-test",
          spanId: "key-test",
          workerQueue: "main",
          queue: "task/key-test",
          isTest: false,
          tags: [],
        },
        prisma
      );
      const message = await vi.waitFor(
        async () => {
          await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
          const [message] = await engine.dequeueFromWorkerQueue({
            consumerId: "key-test",
            workerQueue: "main",
          });
          expect(message).toBeDefined();
          return message!;
        },
        { timeout: 10_000 }
      );
      return { run, message };
    };
    const { run, message } = await triggerAndDequeue(1);

    const workerFor = (engine: RunEngine) =>
      new AuthenticatedWorkerInstance({
        prisma,
        engine,
        type: "MANAGED",
        name: "key-test",
        workerGroupId: "key-test",
        workerInstanceId: "key-test",
        masterQueue: "main",
        region: null,
        workloadType: "CONTAINER",
        allowedSubscriptions: [],
      });
    const authenticateUnmanaged = async (engine: RunEngine, projectId: string | null) => {
      const service = new WorkerGroupTokenService({ prisma, engine });
      const token = await service.createToken();
      await prisma.workerInstanceGroup.create({
        data: {
          type: "UNMANAGED",
          projectId,
          name: "scope-test",
          masterQueue: `${projectId ?? "unbound"}-scope-test`,
          tokenId: token.id,
        },
      });
      return service.authenticate(
        new Request("http://localhost/worker", {
          headers: {
            Authorization: `Bearer ${token.plaintext}`,
            [WORKER_HEADERS.INSTANCE_NAME]: "scope-test",
            [WORKER_HEADERS.MANAGED_SECRET]: MANAGED_WORKER_SECRET,
          },
        })
      );
    };
    const startWith = (
      worker: InstanceType<typeof AuthenticatedWorkerInstance>,
      includeEnvironmentHeader = true
    ) =>
      worker.startRunAttempt({
        runFriendlyId: run.friendlyId,
        snapshotFriendlyId: message.snapshot.friendlyId,
        environmentId: includeEnvironmentHeader ? environment.id : undefined,
      });
    const expectStartable = async () => {
      const unchanged = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
      expect(unchanged.attemptNumber).toBeNull();
      expect(unchanged.status).toBe("DEQUEUED");
      const execution = await engine.getRunExecutionData({ runId: run.id });
      expect(execution?.snapshot.id).toBe(message.snapshot.id);
    };

    // Catches: older callers without an env header starting with no secrets on a replica miss.
    const laggingEngine = new RunEngine({ ...engineOptions, readOnlyPrisma: staleRunReader });
    try {
      await expect(startWith(workerFor(laggingEngine), false)).rejects.toMatchObject({
        status: 503,
      });
      await expectStartable();

      // Catches: returning another environment's prefetched secrets when the engine rejects its scope.
      const other = await createTestOrgProjectWithMember(prisma);
      const otherEnvironment = await createRuntimeEnvironment(prisma, {
        projectId: other.project.id,
        organizationId: other.organization.id,
        type: "PRODUCTION",
      });
      await expect(
        workerFor(engine).startRunAttempt({
          runFriendlyId: run.friendlyId,
          snapshotFriendlyId: message.snapshot.friendlyId,
          environmentId: otherEnvironment.id,
        })
      ).rejects.toMatchObject({ name: "ServiceValidationError", status: 404 });
      await expectStartable();

      // Unknown to the platform keyring, as if access to the wrapping key were lost.
      await prisma.environmentEncryptionKey.update({
        where: { id: key.id },
        data: { wrappingKeyReference: "revoked-wrapping-key" },
      });

      // Catches: project-bound workers probing/decrypting foreign environments before engine scope checks.
      const foreignWorker = await authenticateUnmanaged(engine, other.project.id);
      assertNonNullable(foreignWorker);
      const failures = await Promise.all(
        [environment.id, "missing-environment", undefined].map(async (environmentId) => {
          const response = await foreignWorker
            .startRunAttempt({
              runFriendlyId: run.friendlyId,
              snapshotFriendlyId: message.snapshot.friendlyId,
              environmentId,
            })
            .catch((error) => error);
          expect(response).toBeInstanceOf(Response);
          expect(response.status).toBe(503);
          return response.json();
        })
      );
      expect(failures[0]).toEqual(failures[1]);
      expect(failures[2]).toEqual(failures[1]);
      expect(await authenticateUnmanaged(engine, null)).toBeUndefined();
      await expectStartable();

      const worker = workerFor(engine);
      const start = () => startWith(worker);
      await expect(start()).rejects.toMatchObject({ status: 503 });
      await expectStartable();

      await prisma.environmentEncryptionKey.update({
        where: { id: key.id },
        data: { wrappingKeyReference: key.wrappingKeyReference },
      });
      await new Promise((resolve) => setTimeout(resolve, FAILURE_CACHE_EXPIRY_MS));

      // Catches: env-scoped starts unnecessarily depending on the replica having replayed the run.
      const started = await startWith(workerFor(laggingEngine));
      expect(started.run.attemptNumber).toBe(1);
      expect(started.snapshot.executionStatus).toBe("EXECUTING");
      expect(started.envVars.CUSTOMER_SECRET).toBe("secret");

      const next = await triggerAndDequeue(2);
      const ownWorker = await authenticateUnmanaged(laggingEngine, environment.projectId);
      assertNonNullable(ownWorker);
      const ownStart = await ownWorker.startRunAttempt({
        runFriendlyId: next.run.friendlyId,
        snapshotFriendlyId: next.message.snapshot.friendlyId,
        environmentId: environment.id,
      });
      expect(ownStart.run.attemptNumber).toBe(1);
      expect(ownStart.envVars.CUSTOMER_SECRET).toBe("secret");
    } finally {
      await laggingEngine.quit();
      releaseStaleRead();
      await staleRead;
    }
  }
);
