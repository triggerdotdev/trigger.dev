import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { WORKER_HEADERS } from "@trigger.dev/core/v3/workers";
import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { trace } from "@opentelemetry/api";
import type { PrismaReplicaClient } from "@trigger.dev/database";
import { expect, onTestFinished, vi } from "vitest";
import { resolveEncryptionKeyring } from "~/utils/encryptionKeyring.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  enrollProxyOnlyValue,
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
    process.env.SECRET_PROXY_ENABLED = "true";
    process.env.SECRET_PROXY_PLACEHOLDER_KEYS = JSON.stringify({
      activeKeyId: "test",
      keys: { test: "01".repeat(32) },
    });
    process.env.SECRET_PROXY_SERVICE_TOKEN = "test-service-token-" + "x".repeat(32);
    process.env.RUN_TOKEN_ISSUER_URL = "https://internal-runs.example.com";
    const { $transaction } = await import("~/db.server");
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
      data: {
        featureFlags: {
          [FEATURE_FLAG.environmentEncryptionEnabled]: true,
          [FEATURE_FLAG.runTokenInjection]: true,
        },
      },
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
        variables: [
          { key: "CUSTOMER_SECRET", value: "secret" },
          { key: "NORMAL", value: "ordinary" },
        ],
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
      { isolationLevel: "RepeatableRead", timeout: 60_000 }
    );
    const staleRunReader = await staleReaderReady;

    const trigger = (friendlyId: string, number: number) =>
      engine.trigger(
        {
          number,
          friendlyId,
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
    const run = await trigger("run_keyunavailable", 1);
    const dequeue = () =>
      vi.waitFor(
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

    const message = await dequeue();

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
        supportsSecretProxy: true,
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
      await expect(startWith(worker)).rejects.toMatchObject({ status: 503 });
      await expectStartable();
      await expect(
        worker.startRunAttempt({
          runFriendlyId: run.friendlyId,
          snapshotFriendlyId: message.snapshot.friendlyId,
          environmentId: environment.id,
          supportsRunTokenRefresh: true,
          supportsSecretProxy: true,
          isWarmStart: true,
        })
      ).rejects.toMatchObject({ status: 503 });
      await expectStartable();

      await prisma.environmentEncryptionKey.update({
        where: { id: key.id },
        data: { wrappingKeyReference: key.wrappingKeyReference },
      });
      await new Promise((resolve) => setTimeout(resolve, FAILURE_CACHE_EXPIRY_MS));

      const variable = await prisma.environmentVariable.findFirstOrThrow({
        where: { projectId: environment.projectId, key: "CUSTOMER_SECRET" },
      });
      await enrollProxyOnlyValue(prisma, {
        environmentId: environment.id,
        variableId: variable.id,
        allowedHosts: ["api.example.com"],
      });
      await expect(startWith(workerFor(engine))).rejects.toThrow("supported run token");
      await expectStartable();
      await expect(
        workerFor(engine).startRunAttempt({
          runFriendlyId: run.friendlyId,
          snapshotFriendlyId: message.snapshot.friendlyId,
          environmentId: environment.id,
          supportsRunTokenRefresh: true,
        })
      ).rejects.toThrow("Worker does not support secret proxy");
      await expectStartable();

      await prisma.organization.update({
        where: { id: environment.organizationId },
        data: {
          featureFlags: {
            [FEATURE_FLAG.runTokenInjection]: false,
          },
        },
      });
      await expect(
        workerFor(engine).startRunAttempt({
          runFriendlyId: run.friendlyId,
          snapshotFriendlyId: message.snapshot.friendlyId,
          environmentId: environment.id,
          supportsRunTokenRefresh: true,
          supportsSecretProxy: true,
        })
      ).rejects.toThrow("supported run token");
      await expectStartable();
      await prisma.organization.update({
        where: { id: environment.organizationId },
        data: {
          featureFlags: {
            [FEATURE_FLAG.runTokenInjection]: true,
            [FEATURE_FLAG.environmentEncryptionEnabled]: true,
          },
        },
      });
      await prisma.environmentVariableValue.updateMany({
        where: { variableId: variable.id, environmentId: environment.id },
        data: { isProxyOnly: false, version: { increment: 1 } },
      });

      // Catches: restored keys still blocking warm starts or requiring the replica to replay the run.
      const started = await workerFor(laggingEngine).startRunAttempt({
        runFriendlyId: run.friendlyId,
        snapshotFriendlyId: message.snapshot.friendlyId,
        environmentId: environment.id,
        supportsSecretProxy: true,
        isWarmStart: true,
      });
      expect(started.run.attemptNumber).toBe(1);
      expect(started.snapshot.executionStatus).toBe("EXECUTING");
      expect(started.envVars.CUSTOMER_SECRET).toBe("secret");

      const ownRun = await trigger("run_keyownproject", 2);
      const ownMessage = await dequeue();
      const ownWorker = await authenticateUnmanaged(laggingEngine, environment.projectId);
      assertNonNullable(ownWorker);
      const ownStart = await ownWorker.startRunAttempt({
        runFriendlyId: ownRun.friendlyId,
        snapshotFriendlyId: ownMessage.snapshot.friendlyId,
        environmentId: environment.id,
      });
      expect(ownStart.run.attemptNumber).toBe(1);
      expect(ownStart.envVars.CUSTOMER_SECRET).toBe("secret");

      await expect(
        workerFor(engine).authorizeSuspend(run.friendlyId, environment.id)
      ).resolves.toBe(environment.id);

      // Catches: post-start signing failure stranding a protected attempt or falling back to plaintext.
      await enrollProxyOnlyValue(prisma, {
        environmentId: environment.id,
        variableId: variable.id,
        allowedHosts: ["api.example.com"],
      });
      // Catches: enrollment retroactively disabling checkpoints for an ordinary execution.
      await expect(
        workerFor(engine).authorizeSuspend(run.friendlyId, environment.id)
      ).resolves.toBe(environment.id);
      const protectedRun = await trigger("run_proxysigningfailure", 3);
      const protectedMessage = await dequeue();
      // No active signing key exists in this database.
      await expect(
        workerFor(laggingEngine).startRunAttempt({
          runFriendlyId: protectedRun.friendlyId,
          snapshotFriendlyId: protectedMessage.snapshot.friendlyId,
          environmentId: environment.id,
          supportsRunTokenRefresh: true,
          supportsSecretProxy: true,
        })
      ).rejects.toMatchObject({ status: 503 });
      const failed = await prisma.taskRun.findFirstOrThrow({ where: { id: protectedRun.id } });
      expect(failed.status).toBe("PENDING");
      expect(failed.attemptNumber).toBe(1);
      expect(
        (await engine.getRunExecutionData({ runId: protectedRun.id }))?.snapshot.executionStatus
      ).toBe("QUEUED");

      const { internalRunSigningService } = await import("~/services/oidc/instance.server");
      const actor = await prisma.user.findFirstOrThrow({ select: { id: true } });
      const signingKey = await internalRunSigningService.generateStagedKey(actor.id);
      await prisma.oidcSigningKey.update({
        where: { id: signingKey.id },
        data: { readyAt: new Date(0) },
      });
      await internalRunSigningService.activateKey(signingKey.id, actor.id);
      const proxyRun = protectedRun;
      const proxyMessage = await dequeue();
      // Catches: resolving variables again after start, or re-reading protected policy during finalization.
      let locked!: () => void;
      const lockReady = new Promise<void>((resolve) => (locked = resolve));
      let releaseSigning!: () => void;
      const signingReleased = new Promise<void>((resolve) => (releaseSigning = resolve));
      const signingLock = $transaction(prisma, async (tx) => {
        await tx.$executeRaw`LOCK TABLE "OidcSigningKey" IN ACCESS EXCLUSIVE MODE`;
        locked();
        await signingReleased;
      });
      await lockReady;
      const delivering = workerFor(laggingEngine).startRunAttempt({
        runFriendlyId: proxyRun.friendlyId,
        snapshotFriendlyId: proxyMessage.snapshot.friendlyId,
        environmentId: environment.id,
        supportsRunTokenRefresh: true,
        supportsSecretProxy: true,
      });
      try {
        await vi.waitFor(async () => {
          const current = await prisma.taskRun.findFirstOrThrow({ where: { id: proxyRun.id } });
          expect(current.status).toBe("EXECUTING");
        });
        const secretKey = `environmentvariable:${environment.projectId}:${environment.id}:NORMAL`;
        const prepared = await encryption.prepareWrite({
          projectId: environment.projectId,
          environmentId: environment.id,
        });
        await prisma.secretStore.update({
          where: { key: secretKey },
          data: {
            value: encryption.encrypt(
              prepared,
              {
                environmentId: environment.id,
                purpose: "environment-variable",
                objectId: secretKey,
              },
              JSON.stringify({ secret: "changed-after-start" })
            ),
          },
        });
        await prisma.environmentVariableValue.updateMany({
          where: { variableId: variable.id, environmentId: environment.id },
          data: {
            proxyConfig: { allowedHosts: ["changed.example.com"] },
            version: { increment: 1 },
          },
        });
      } finally {
        releaseSigning();
        await signingLock;
      }
      const delivery = await delivering;
      expect(delivery.envVars.CUSTOMER_SECRET).toMatch(/^trsec_v1_/);
      expect(delivery.envVars.NORMAL).toBe("ordinary");
      expect(delivery.envVars.TRIGGER_SECRET_KEY).toBeTruthy();
      expect(delivery.envVars.TRIGGER_RUN_TOKEN).toBeTruthy();
      expect(delivery.secretProxy).toMatchObject({
        runId: proxyRun.friendlyId,
        attempt: 2,
        allowedHosts: ["api.example.com"],
      });
    } finally {
      await laggingEngine.quit();
      releaseStaleRead();
      await staleRead;
    }
  }
);
