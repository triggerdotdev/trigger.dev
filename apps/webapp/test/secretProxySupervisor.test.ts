import { RunEngine, EngineServiceValidationError } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { assertNonNullable, postgresAndRedisTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { RunId, SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import { sandboxExecutionPolicy } from "@trigger.dev/core/v3";
import type { AuthenticatedWorkerInstance } from "~/v3/services/worker/workerGroupTokenService.server";
import { enrollProxyOnlyValue } from "./fixtures/environmentVariablesFixtures";
import {
  SupervisorHttpClient,
  WorkloadHttpClient,
  WorkerApiRunAttemptCompleteRequestBody,
  WorkerApiRunAttemptStartRequestBody,
  WORKER_HEADERS,
  WORKLOAD_HEADERS,
} from "@trigger.dev/core/v3/workers";
import { createServer, request, type Server } from "node:http";
import type { RedisOptions } from "ioredis";
import type { PrismaClient } from "@trigger.dev/database";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, onTestFinished, vi } from "vitest";
import {
  SecretProxyFixture,
  deploymentClaims,
  executionInput,
} from "../../supervisor/src/services/fixtures/secretProxy.js";
import {
  SecretProxyBindings,
  type SecretProxyCaller,
} from "../../supervisor/src/services/secretProxyBindings.js";
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

async function engineBoundary(
  engine: RunEngine,
  environmentId: string,
  reportStatus: () => number = () => 503,
  beforeComplete?: (body: WorkerApiRunAttemptCompleteRequestBody) => Promise<void>,
  worker?: Pick<AuthenticatedWorkerInstance, "startRunAttempt">
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
      if (match[3] === "attempts/start" && worker) {
        const input = WorkerApiRunAttemptStartRequestBody.parse(body);
        const result = await worker.startRunAttempt({
          ...input,
          runFriendlyId: match[1]!,
          snapshotFriendlyId: match[2]!,
          environmentId,
          runnerId: req.headers[WORKLOAD_HEADERS.RUNNER_ID] as string | undefined,
          // The real route reads the supervisor's verified sandbox run claim from this header.
          sandboxRunId: req.headers[WORKER_HEADERS.SANDBOX_RUN_ID] as string | undefined,
        });
        res.end(JSON.stringify(result));
      } else if (match[3] === "restore-outcome") {
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
        await beforeComplete?.(input);
        const result = await engine.completeRunAttempt({
          runId,
          snapshotId,
          environmentId,
          ...input,
          runnerId: req.headers[WORKLOAD_HEADERS.RUNNER_ID] as string | undefined,
        });
        res.end(JSON.stringify({ result }));
      } else res.writeHead(404).end();
    })().catch(async (error) => {
      if (error instanceof Response) {
        res.writeHead(error.status, Object.fromEntries(error.headers)).end(await error.text());
      } else {
        res
          .writeHead(error instanceof EngineServiceValidationError ? (error.status ?? 500) : 500)
          .end(JSON.stringify({ error: String(error) }));
      }
    });
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
  "ordinary retries remain immediate on proxy-enabled supervisors",
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
      { proxy: true },
      { proxy: true, forceRequeue: false },
      { proxy: false },
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
      const secretProxy = options.proxy ? bindings() : undefined;
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
        secretProxy,
        wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
        wideEventsNoisyRoutes: false,
      });
      await server.start();
      try {
        const completion = {
          ok: false as const,
          id: run.friendlyId,
          error: {
            type: "BUILT_IN_ERROR" as const,
            name: "Error",
            message: "retry",
            stackTrace: "",
          },
          retry: { delay: 100, timestamp: Date.now() + 100 },
        };
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
              completion,
            }),
          }
        );
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.result.attemptStatus).toBe("RETRY_IMMEDIATELY");
        const persisted = await engine.getRunExecutionData({ runId: run.id });
        expect(persisted?.snapshot.executionStatus).toBe("EXECUTING");
      } finally {
        await server.stop();
      }
    }
  }
);

async function setupProxyRun(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  options: {
    annotations?: Parameters<RunEngine["trigger"]>[0]["annotations"];
    singleUse?: boolean;
  } = {}
) {
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
  const { deployment } = await setupBackgroundWorker(engine, environment, "proxy-retry");
  assertNonNullable(deployment);
  async function trigger() {
    return engine.trigger(
      {
        number: 1,
        friendlyId: RunId.generate().friendlyId,
        environment,
        taskIdentifier: "proxy-retry",
        annotations: options.annotations,
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: "proxy-retry",
        spanId: "proxy-retry",
        workerQueue: "proxy-retry",
        queue: "task/proxy-retry",
        isTest: false,
        tags: [],
      },
      prisma
    );
  }
  const run = await trigger();
  async function dequeue() {
    let dequeued: Awaited<ReturnType<RunEngine["dequeueFromWorkerQueue"]>>[number] | undefined;
    await expect
      .poll(
        async () => {
          dequeued = (
            await engine.dequeueFromWorkerQueue({ consumerId: "test", workerQueue: "proxy-retry" })
          )[0];
          return !!dequeued;
        },
        { timeout: 10_000, interval: 100 }
      )
      .toBe(true);
    assertNonNullable(dequeued);
    return dequeued;
  }
  const dequeued = await dequeue();
  const claims = {
    ...deploymentClaims,
    environment_id: environment.id,
    deployment: deployment.friendlyId,
    org_id: environment.organizationId,
    project_id: environment.projectId,
    deployment_version: deployment.version,
  };
  const proxy = bindings();
  await proxy.start();
  const callers = await fixture.placements(
    [
      { runId: run.friendlyId, singleUse: options.singleUse },
      { runId: RunId.generate().friendlyId },
    ],
    claims
  );
  for (const caller of callers) await fixture.registerAllocation(caller);
  async function start(caller: SecretProxyCaller, snapshotId: string, registrar = proxy) {
    const placement = await registrar.prepareStart(caller);
    expect(placement).toBeDefined();
    return registrar.withStart(placement!, async () => {
      const started = await engine.startRunAttempt({
        runId: run.id,
        snapshotId,
        runnerId: caller.runnerId,
        environmentId: environment.id,
        enforceDuplicateAttemptStart: true,
      });
      const input = executionInput(caller, started.execution.attempt.number);
      await registrar.activateStart(caller, placement!, {
        ...started,
        secretProxy: input.proxy,
        envVars: { TRIGGER_RUN_TOKEN: input.runToken },
      });
      return started;
    });
  }
  return { engine, environment, run, dequeued, callers, proxy, start, claims, trigger, dequeue };
}

async function currentBindingId(caller: SecretProxyCaller): Promise<string> {
  const guestId = fixture.allocation(caller).metadata.guestId;
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: fixture.socketPath, path: `/allocations/${guestId}` },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()).bindingId);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

postgresAndRedisTest(
  "a second placement cannot bind an already executing run",
  async ({ prisma, redisOptions }) => {
    const f = await setupProxyRun(prisma, redisOptions);
    const first = f.callers[0]!;
    const second = { ...f.callers[1]!, runId: f.run.friendlyId };
    const secondProxy = bindings();
    await secondProxy.start();
    const started = await f.start(first, f.dequeued.snapshot.id);
    const bindingId = await currentBindingId(first);
    await expect(f.start(second, started.snapshot.id, secondProxy)).rejects.toMatchObject({
      status: 409,
      metadata: { code: "ATTEMPT_ALREADY_EXECUTING" },
    });
    const persisted = await f.engine.getRunExecutionData({ runId: f.run.id });
    expect(persisted?.run.attemptNumber).toBe(1);
    expect(persisted?.snapshot.id).toBe(started.snapshot.id);
    expect(await currentBindingId(first)).toBe(bindingId);
    expect(await fixture.acceptsTls(first)).toBe(true);
    expect(await fixture.acceptsTls(second)).toBe(false);
  }
);

async function loopbackPlacement(caller: SecretProxyCaller): Promise<SecretProxyCaller> {
  const pod = await fixture.core.readNamespacedPod({
    name: caller.runnerId!,
    namespace: fixture.namespace,
  });
  await fixture.core.replaceNamespacedPodStatus({
    name: caller.runnerId!,
    namespace: fixture.namespace,
    body: { ...pod, status: { ...pod.status, podIP: "127.0.0.1", podIPs: [{ ip: "127.0.0.1" }] } },
  });
  return { ...caller, sourceIp: "127.0.0.1" };
}

postgresAndRedisTest(
  "sandbox proxy delivery is bootstrap-only and reused allocations cannot claim cold starts",
  async ({ prisma, redisOptions, postgresContainer }) => {
    const encryptionKey = "0123456789abcdef0123456789abcdef";
    Object.assign(process.env, {
      DATABASE_URL: postgresContainer.getConnectionUri(),
      DIRECT_URL: postgresContainer.getConnectionUri(),
      ENCRYPTION_KEY: encryptionKey,
      SECRET_PROXY_ENABLED: "true",
      SECRET_PROXY_PLACEHOLDER_KEYS: JSON.stringify({
        activeKeyId: "test",
        keys: { test: "01".repeat(32) },
      }),
      SECRET_PROXY_SERVICE_TOKEN: "test-service-token-" + "x".repeat(32),
      RUN_TOKEN_ISSUER_URL: "https://internal-runs.example.com",
    });
    delete process.env.DATABASE_READ_REPLICA_URL;
    delete process.env.ENCRYPTION_KEYRING;
    const { $transaction } = await import("~/db.server");
    const { EnvironmentEncryptionService } =
      await import("~/services/environmentEncryption/service.server");
    const { EnvironmentVariablesRepository } =
      await import("~/v3/environmentVariables/environmentVariablesRepository.server");
    const { resolveEncryptionKeyring } = await import("~/utils/encryptionKeyring.server");
    const { FEATURE_FLAG } = await import("~/v3/featureFlags");
    const { AuthenticatedWorkerInstance } =
      await import("~/v3/services/worker/workerGroupTokenService.server");
    const f = await setupProxyRun(prisma, redisOptions, {
      annotations: {
        triggerSource: "sdk",
        triggerAction: "trigger",
        rootTriggerSource: "sdk",
        executionMode: "SANDBOX",
        executionPolicy: sandboxExecutionPolicy({ envVars: ["GRANTED"] }),
      },
      singleUse: true,
    });
    await prisma.organization.update({
      where: { id: f.environment.organizationId },
      data: { featureFlags: { [FEATURE_FLAG.environmentEncryptionEnabled]: true } },
    });
    const keyring = resolveEncryptionKeyring(undefined, encryptionKey);
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
    await new EnvironmentVariablesRepository(prisma, prisma, encryption).create(
      f.environment.projectId,
      {
        override: true,
        environmentIds: [f.environment.id],
        variables: [{ key: "GRANTED", value: "sandbox-secret" }],
      }
    );
    const variable = await prisma.environmentVariable.findFirstOrThrow({
      where: { projectId: f.environment.projectId, key: "GRANTED" },
    });
    await enrollProxyOnlyValue(prisma, {
      environmentId: f.environment.id,
      variableId: variable.id,
      allowedHosts: ["api.example.com"],
    });
    // Sandbox runs fail closed without a run token, so they need an active signing key.
    const { internalRunSigningService } = await import("~/services/oidc/instance.server");
    const actorUserId = "signing-test-actor";
    const signingKey = await internalRunSigningService.generateStagedKey(actorUserId);
    await prisma.oidcSigningKey.update({
      where: { id: signingKey.id },
      data: { readyAt: new Date(0) },
    });
    await internalRunSigningService.activateKey(signingKey.id, actorUserId);
    const caller = await loopbackPlacement(f.callers[0]!);
    const worker = new AuthenticatedWorkerInstance({
      prisma,
      engine: f.engine,
      type: "MANAGED",
      name: "proxy-policy",
      workerGroupId: "proxy-policy",
      workerInstanceId: "proxy-policy",
      masterQueue: "proxy-retry",
      region: null,
      workloadType: "CONTAINER",
      allowedSubscriptions: [],
    });
    const starts: Parameters<AuthenticatedWorkerInstance["startRunAttempt"]>[0][] = [];
    const client = await engineBoundary(f.engine, f.environment.id, undefined, undefined, {
      startRunAttempt: async (input) => {
        starts.push(input);
        return worker.startRunAttempt(input);
      },
    });
    // The supervisor mints a run-scoped token for a sandbox Runner.
    const token = await mintDeploymentToken({
      ...f.claims,
      execution_mode: "SANDBOX",
      run: f.run.friendlyId,
    });
    assertNonNullable(token);
    const portReservation = createServer();
    const port = await listen(portReservation);
    await close(portReservation);
    const server = new WorkloadServer({
      port,
      host: "127.0.0.1",
      workerClient: client,
      secretProxy: f.proxy,
      wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
      wideEventsNoisyRoutes: false,
    });
    await server.start();
    const workload = new WorkloadHttpClient({
      workerApiUrl: `http://127.0.0.1:${port}`,
      runnerId: caller.runnerId!,
      deploymentId: token,
      deploymentVersion: f.claims.deployment_version,
      projectRef: "test",
    });
    try {
      expect(await f.proxy.prepareStart(caller)).toMatchObject({
        singleUseAttempt: 1,
        isWarmStart: false,
      });
      const started = await workload.startRunAttempt(
        f.run.friendlyId,
        f.dequeued.snapshot.friendlyId,
        { isWarmStart: false, supportsRunTokenRefresh: true }
      );
      expect(started.success).toBe(true);
      if (!started.success) throw new Error(started.error);
      expect(started.data.execution.attempt.number).toBe(1);
      expect(started.data.envVars.GRANTED).toBeDefined();
      expect(started.data.envVars.GRANTED).not.toBe("sandbox-secret");
      expect(started.data.envVars.TRIGGER_SECRET_KEY).toBeUndefined();
      expect(await fixture.acceptsTls(caller)).toBe(true);
      expect(starts[0]).toMatchObject({ isWarmStart: false, supportsSecretProxy: true });

      await f.proxy.complete(
        caller,
        () =>
          client.completeRunAttempt(
            f.run.friendlyId,
            started.data!.snapshot.friendlyId,
            {
              attemptNumber: 1,
              completion: {
                ok: false,
                id: f.run.friendlyId,
                error: { type: "BUILT_IN_ERROR", name: "Error", message: "retry", stackTrace: "" },
                retry: { delay: 0, timestamp: Date.now() },
              },
              forceRequeue: true,
            },
            caller.runnerId,
            f.environment.id
          ),
        1
      );
      expect(await fixture.acceptsTls(caller)).toBe(false);
      const pending = await f.dequeue();

      const reused = await workload.startRunAttempt(f.run.friendlyId, pending.snapshot.friendlyId, {
        isWarmStart: false,
        supportsRunTokenRefresh: true,
      });
      expect(reused.success).toBe(false);
      expect(starts).toHaveLength(1);
      const unchanged = await f.engine.getRunExecutionData({ runId: f.run.id });
      expect(unchanged?.run.attemptNumber).toBe(1);
      expect(unchanged?.snapshot.id).toBe(pending.snapshot.id);
      expect(await fixture.acceptsTls(caller)).toBe(false);
    } finally {
      await server.stop();
    }
  }
);

postgresAndRedisTest(
  "a later-snapshot completion after supervisor restart revokes before retry and only its owner can complete",
  async ({ prisma, redisOptions }) => {
    const f = await setupProxyRun(prisma, redisOptions);
    const caller = await loopbackPlacement(f.callers[0]!);
    const started = await f.start(caller, f.dequeued.snapshot.id);
    const previousBinding = await currentBindingId(caller);
    await f.proxy.stop();
    expect(await fixture.acceptsTls(caller)).toBe(true);
    const replacement = bindings();
    await replacement.start();
    let boundAttempt = 1;
    const client = await engineBoundary(f.engine, f.environment.id, undefined, async (body) => {
      expect(await fixture.acceptsTls(caller)).toBe(
        body.attemptNumber !== undefined && body.attemptNumber < boundAttempt
      );
    });
    const token = await mintDeploymentToken(f.claims);
    assertNonNullable(token);
    const portReservation = createServer();
    const port = await listen(portReservation);
    await close(portReservation);
    const server = new WorkloadServer({
      port,
      host: "127.0.0.1",
      workerClient: client,
      secretProxy: replacement,
      wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
      wideEventsNoisyRoutes: false,
    });
    await server.start();
    try {
      const path = `http://127.0.0.1:${port}/api/v1/workload-actions/runs/${f.run.friendlyId}/snapshots/${started.snapshot.friendlyId}`;
      const headers = {
        "content-type": "application/json",
        [WORKLOAD_HEADERS.RUNNER_ID]: caller.runnerId!,
        [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
      };
      const wrongCaller = await fetch(`${path}/attempts/complete`, {
        method: "POST",
        headers: { ...headers, [WORKLOAD_HEADERS.RUNNER_ID]: f.callers[1]!.runnerId! },
        body: JSON.stringify({
          completion: { ok: true, id: f.run.friendlyId, outputType: "application/json" },
        }),
      });
      expect(wrongCaller.ok).toBe(false);
      expect((await f.engine.getRunExecutionData({ runId: f.run.id }))?.snapshot.id).toBe(
        started.snapshot.id
      );
      expect(await fixture.acceptsTls(caller)).toBe(true);

      const continued = await f.engine.executionSnapshotSystem.createExecutionSnapshot(prisma, {
        run: { id: f.run.id, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "Continued execution" },
        previousSnapshotId: started.snapshot.id,
        environmentId: f.environment.id,
        environmentType: f.environment.type,
        projectId: f.environment.projectId,
        organizationId: f.environment.organizationId,
        runnerId: caller.runnerId,
      });
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v1/workload-actions/runs/${f.run.friendlyId}/snapshots/${continued.friendlyId}/attempts/complete`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            attemptNumber: 1,
            completion: {
              ok: false,
              id: f.run.friendlyId,
              error: { type: "BUILT_IN_ERROR", name: "Error", message: "retry", stackTrace: "" },
              retry: { delay: 100, timestamp: Date.now() + 100 },
            },
          }),
        }
      );
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.result.attemptStatus).toBe("RETRY_IMMEDIATELY");
      expect(await fixture.acceptsTls(caller)).toBe(false);
      const retried = await f.start(
        await loopbackPlacement(caller),
        result.result.snapshot.id,
        replacement
      );
      expect(retried.run.attemptNumber).toBe(2);
      expect(await currentBindingId(caller)).not.toBe(previousBinding);
      expect(await fixture.acceptsTls(caller)).toBe(true);
      boundAttempt = 2;
      const completionUrl = `http://127.0.0.1:${port}/api/v1/workload-actions/runs/${f.run.friendlyId}/snapshots/${retried.snapshot.friendlyId}/attempts/complete`;
      const success = { ok: true, id: f.run.friendlyId, outputType: "application/json" };
      const stale = await fetch(completionUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ attemptNumber: 1, completion: success }),
      });
      expect(stale.status).toBe(500);
      expect(await fixture.acceptsTls(caller)).toBe(true);
      expect((await f.engine.getRunExecutionData({ runId: f.run.id }))?.snapshot.id).toBe(
        retried.snapshot.id
      );
      const completed = await fetch(completionUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ attemptNumber: 2, completion: success }),
      });
      expect(completed.status).toBe(200);
      expect(await fixture.acceptsTls(caller)).toBe(false);
    } finally {
      await server.stop();
    }
  }
);

postgresAndRedisTest(
  "busy retirement fences a pending platform start and retries its forced settlement",
  async ({ prisma, redisOptions }) => {
    const f = await setupProxyRun(prisma, redisOptions);
    const caller = await loopbackPlacement(f.callers[0]!);
    const signals = new EventEmitter();
    const accepted = once(signals, "accepted");
    const responseGate = once(signals, "respond");
    const retiring = once(signals, "retiring");
    const retirementGate = once(signals, "retire");
    const completions: WorkerApiRunAttemptCompleteRequestBody[] = [];
    let acknowledgeCompletion = false;
    const client = await engineBoundary(
      f.engine,
      f.environment.id,
      undefined,
      async (body) => {
        completions.push(body);
        if (!acknowledgeCompletion)
          throw new Response(JSON.stringify({ error: "Unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json", "x-should-retry": "false" },
          });
      },
      {
        startRunAttempt: async (input) => {
          const started = await f.engine.startRunAttempt({
            runId: RunId.fromFriendlyId(input.runFriendlyId),
            snapshotId: SnapshotId.fromFriendlyId(input.snapshotFriendlyId),
            environmentId: f.environment.id,
            runnerId: input.runnerId,
            enforceDuplicateAttemptStart: true,
          });
          const authority = executionInput(caller, started.execution.attempt.number);
          signals.emit("accepted");
          await responseGate;
          return {
            ...started,
            secretProxy: authority.proxy,
            envVars: { TRIGGER_RUN_TOKEN: authority.runToken },
          };
        },
      }
    );
    const token = await mintDeploymentToken(f.claims);
    assertNonNullable(token);
    const portReservation = createServer();
    const port = await listen(portReservation);
    await close(portReservation);
    const retired: string[] = [];
    const server = new WorkloadServer({
      port,
      host: "127.0.0.1",
      workerClient: client,
      secretProxy: f.proxy,
      retireRunner: async (runnerId, uid) => {
        signals.emit("retiring");
        await retirementGate;
        await fixture.custom.deleteNamespacedCustomObject({
          group: "compute.trigger.dev",
          version: "v1alpha1",
          namespace: fixture.namespace,
          plural: "runners",
          name: runnerId,
          body: { preconditions: { uid } },
        });
        retired.push(runnerId);
      },
      wideEventOpts: { service: "supervisor", env: { nodeId: "test" }, enabled: false },
      wideEventsNoisyRoutes: false,
    });
    await server.start();
    try {
      const next = await f.trigger();
      const dispatched = await f.dequeue();
      expect(dispatched.run.friendlyId).toBe(next.friendlyId);
      const workload = new WorkloadHttpClient({
        workerApiUrl: `http://127.0.0.1:${port}`,
        runnerId: caller.runnerId!,
        deploymentId: token,
        deploymentVersion: f.claims.deployment_version,
        projectRef: "test",
      });
      const first = fetch(
        `http://127.0.0.1:${port}/api/v1/workload-actions/runs/${f.run.friendlyId}/snapshots/${f.dequeued.snapshot.friendlyId}/attempts/start`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [WORKLOAD_HEADERS.RUNNER_ID]: caller.runnerId!,
            [WORKLOAD_HEADERS.DEPLOYMENT_ID]: token,
          },
          body: JSON.stringify({ isWarmStart: false }),
        }
      );
      await accepted;
      const busy = workload.startRunAttempt(next.friendlyId, dispatched.snapshot.friendlyId, {
        isWarmStart: true,
      });
      await retiring;
      expect(await f.proxy.prepareStart(caller)).toBeDefined();
      signals.emit("respond");
      expect((await first).status).toBe(500);
      expect(await fixture.acceptsTls(caller)).toBe(false);
      expect(completions[0]).toMatchObject({
        attemptNumber: 1,
        forceRequeue: true,
        completion: { ok: false, id: f.run.friendlyId },
      });
      signals.emit("retire");
      expect(await busy).toMatchObject({ success: false, statusCode: 410, shouldRetry: false });
      acknowledgeCompletion = true;
      await expect
        .poll(
          async () => {
            const settled = await f.engine.getRunExecutionData({ runId: f.run.id });
            return settled?.snapshot.executionStatus;
          },
          { timeout: 20_000, interval: 100 }
        )
        .toBe("QUEUED");
      expect(completions.length).toBeGreaterThan(1);
      expect(retired).toEqual([caller.runnerId]);
      await expect(
        fixture.custom.getNamespacedCustomObject({
          group: "compute.trigger.dev",
          version: "v1alpha1",
          namespace: fixture.namespace,
          plural: "runners",
          name: caller.runnerId!,
        })
      ).rejects.toMatchObject({ code: 404 });
      expect(await fixture.acceptsTls(caller)).toBe(false);
      const persisted = await f.engine.getRunExecutionData({ runId: next.id });
      const pendingRun = await prisma.taskRun.findUniqueOrThrow({
        where: { id: next.id },
        select: { attemptNumber: true },
      });
      expect(pendingRun.attemptNumber).toBeNull();
      expect(persisted?.snapshot.id).toBe(dispatched.snapshot.id);
      expect(persisted?.snapshot.executionStatus).toBe("PENDING_EXECUTING");
    } finally {
      signals.emit("respond");
      signals.emit("retire");
      await server.stop();
    }
  }
);
