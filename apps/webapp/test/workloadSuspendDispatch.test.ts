import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { containerTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";

vi.unmock("~/v3/runEngine.server");
const api = vi.hoisted(() => ({
  custom: {
    getNamespacedCustomObject: vi.fn(),
    listNamespacedCustomObject: vi.fn(async () => ({ items: [] })),
  },
  objects: { patch: vi.fn(async () => ({})) },
}));
vi.mock("../../supervisor/src/clients/kubernetes", () => ({ createK8sApi: () => api }));

containerTest(
  "real suspend auth binds physical ownership, reports refusals, and retries storage outages",
  async ({ postgresContainer, redisOptions }) => {
    Object.assign(process.env, {
      DATABASE_URL: postgresContainer.getConnectionUri(),
      DIRECT_URL: postgresContainer.getConnectionUri(),
      REDIS_HOST: redisOptions.host,
      REDIS_PORT: String(redisOptions.port),
      REDIS_TLS_DISABLED: "true",
      SESSION_SECRET: "test-session-secret",
      MAGIC_LINK_SECRET: "test-magic-link-secret",
      ENCRYPTION_KEY: "test-encryption-key-for-e2e!!!!!",
      PROVIDER_SECRET: "test-provider-secret",
      COORDINATOR_SECRET: "test-coordinator-secret",
      MANAGED_WORKER_SECRET: "test-managed-worker-secret",
      DEPLOY_REGISTRY_HOST: "registry.example.com",
      V4_DEPLOY_REGISTRY_HOST: "registry.example.com",
      CLICKHOUSE_URL: "http://localhost:8123",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      RUN_ENGINE_TTL_SYSTEM_DISABLED: "true",
      RUN_ENGINE_TTL_CONSUMERS_DISABLED: "true",
      WORKLOAD_CREATED_AT_GATE_ENABLED: "1",
      WORKLOAD_TOKEN_CUTOFF: "2026-09-01T00:00:00.000Z",
      WORKLOAD_TOKEN_ENFORCEMENT: "enforce",
      WORKLOAD_TOKEN_SECRET: "suspend-integration-secret",
      WORKER_ENABLED: "false",
      RUN_ENGINE_WORKER_ENABLED: "0",
      COMMON_WORKER_ENABLED: "0",
      BATCH_QUEUE_WORKER_ENABLED: "false",
      SCHEDULE_WORKER_ENABLED: "0",
      RUN_REPLICATION_ENABLED: "0",
    });
    const { PrismaClient } = await import("@trigger.dev/database");
    const prisma = new PrismaClient({
      datasources: { db: { url: postgresContainer.getConnectionUri() } },
    });
    const { engine } = await import("~/v3/runEngine.server");
    const { WorkerGroupTokenService } =
      await import("~/v3/services/worker/workerGroupTokenService.server");
    const { setupAuthenticatedEnvironment } = await import("@internal/run-engine/tests");
    const { action: preflight } =
      await import("~/routes/engine.v1.worker-actions.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.suspend.preflight");
    const { action: completion } =
      await import("~/routes/engine.v1.worker-actions.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.suspend");
    const { SupervisorHttpClient, WORKLOAD_HEADERS } = await import("@trigger.dev/core/v3/workers");
    const { mintWorkloadDeploymentToken } = await import("@trigger.dev/core/v3");
    const token = await new WorkerGroupTokenService({ prisma, engine }).createToken();
    await prisma.workerInstanceGroup.create({
      data: {
        type: "MANAGED",
        name: "suspend-integration",
        masterQueue: "main",
        tokenId: token.id,
      },
    });
    process.env.TRIGGER_API_URL = "http://localhost:3030";
    process.env.TRIGGER_WORKER_TOKEN = token.plaintext;
    const { WorkloadServer } = await import("../../supervisor/src/workloadServer/index");
    const { RunCrdWorkloadManager } = await import("../../supervisor/src/workloadManager/runCrd");
    const replies: number[] = [];
    const gate = createServer(async (request, response) => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        const match = request.url!.match(
          /\/runs\/([^/]+)\/snapshots\/([^/]+)\/suspend(\/preflight)?$/
        )!;
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers))
          if (value) headers.set(name, Array.isArray(value) ? value.join(",") : value);
        const result = await (match[3] ? preflight : completion)({
          request: new Request(`http://localhost${request.url}`, {
            method: "POST",
            headers,
            body: body || undefined,
          }),
          params: { runFriendlyId: match[1], snapshotFriendlyId: match[2] },
          context: {},
        });
        replies.push(result.status);
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(await result.text());
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    });
    await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
    const worker = new SupervisorHttpClient({
      apiUrl: `http://127.0.0.1:${(gate.address() as AddressInfo).port}`,
      workerToken: token.plaintext,
      instanceName: "suspend-integration",
      managedWorkerSecret: "test-managed-worker-secret",
    });
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const manager = new RunCrdWorkloadManager({
      workloadApiProtocol: "http",
      workloadApiPort: port,
      namespace: "test",
      nodeName: "node-a",
      runtime: "microvm",
      snapshots: { enabled: true, delayMs: 0, dispatchLimit: 1 },
      suspendPollMs: 1,
      suspendTimeoutMs: 20,
    });
    const workload = new WorkloadServer({
      port,
      workerClient: worker,
      runnerSnapshotter: manager,
      wideEventOpts: { service: "suspend-test", env: {}, enabled: false },
      wideEventsNoisyRoutes: false,
    });
    await workload.start();
    try {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_suspendintegration",
          environment,
          taskIdentifier: "suspend",
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "suspend",
          spanId: "suspend",
          workerQueue: "main",
          queue: "task/suspend",
          isTest: false,
          tags: [],
        },
        prisma
      );
      const execution = (await engine.getRunExecutionData({ runId: run.id }))!;
      const snapshotId = execution.snapshot.friendlyId;
      const deployment = "deployment_test";
      api.custom.getNamespacedCustomObject.mockImplementation(async ({ name }) => ({
        metadata: {
          annotations:
            name === "foreign"
              ? {
                  "compute.trigger.dev/suspend": "snapshot_earlier",
                  "compute.trigger.dev/suspend-run": run.friendlyId,
                }
              : {},
        },
        spec: {
          owner: { envID: name === "foreign" ? "env_foreign" : environment.id },
          deployment: { friendlyID: name === "other-deployment" ? "deployment_other" : deployment },
          // Warm runners retain the run that bootstrapped them, not the current run.
          bootstrap: { runFriendlyID: "run_bootstrap" },
        },
        status:
          name === "foreign"
            ? {
                phase: "Running",
                suspend: { request: "snapshot_earlier", snapshotID: "earlier", node: "node-a" },
                conditions: [{ type: "Suspended", status: "True", reason: "SnapshotTaken" }],
              }
            : { phase: "Running" },
      }));
      async function suspend(runnerId: string, deploymentToken?: string) {
        replies.length = 0;
        api.objects.patch.mockClear();
        const result = await fetch(
          `http://127.0.0.1:${port}/api/v1/workload-actions/runs/${run.friendlyId}/snapshots/${snapshotId}/suspend`,
          {
            headers: {
              [WORKLOAD_HEADERS.RUNNER_ID]: runnerId,
              [WORKLOAD_HEADERS.PROJECT_REF]: environment.project.externalRef,
              [WORKLOAD_HEADERS.DEPLOYMENT_VERSION]: "1",
              ...(deploymentToken ? { [WORKLOAD_HEADERS.DEPLOYMENT_ID]: deploymentToken } : {}),
            },
          }
        );
        expect(result.status).toBe(202);
        await vi.waitFor(() => expect(replies).toHaveLength(2));
      }
      await prisma.taskRun.update({
        where: { id: run.id },
        data: { createdAt: new Date("2026-08-31") },
      });
      await suspend("foreign");
      expect(replies).toEqual([200, 200]);
      expect(api.objects.patch).not.toHaveBeenCalled();
      await suspend("owned");
      expect(api.objects.patch).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ name: "owned" }) }),
        undefined,
        undefined,
        undefined,
        undefined,
        expect.any(String)
      );
      await prisma.taskRun.update({
        where: { id: run.id },
        data: { createdAt: new Date("2026-09-02") },
      });
      await suspend("foreign");
      expect(replies).toEqual([403, 200]);
      expect(api.objects.patch).not.toHaveBeenCalled();

      const legacyFailure = await worker.submitSuspendCompletion({
        runId: run.friendlyId,
        snapshotId,
        body: { success: false, error: "legacy reporter" },
      });
      expect(legacyFailure).toMatchObject({ success: true });
      replies.length = 0;
      const read = vi
        .spyOn(engine.runStore, "findLatestExecutionSnapshot")
        .mockRejectedValueOnce(new Error("temporary storage outage"));
      try {
        expect(
          await worker.preflightSuspend(run.friendlyId, snapshotId, "owned", environment.id)
        ).toMatchObject({ success: true, data: { environmentId: environment.id } });
        expect(replies).toEqual([500, 200]);
      } finally {
        read.mockRestore();
      }
      const deploymentToken = await mintWorkloadDeploymentToken(
        {
          deployment,
          deployment_version: "1",
          environment_id: environment.id,
          environment_type: "PRODUCTION",
          org_id: environment.organizationId,
          project_id: environment.projectId,
        },
        "suspend-integration-secret",
        Math.floor(Date.now() / 1000) + 60
      );
      for (const target of ["foreign", "other-deployment"]) {
        await suspend(target, deploymentToken);
        expect(replies).toEqual([200, 200]);
        expect(api.objects.patch).not.toHaveBeenCalled();
      }
      await suspend("owned", deploymentToken);
      expect(replies).toEqual([200, 200]);
      expect(api.objects.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            name: "owned",
            annotations: expect.objectContaining({ "compute.trigger.dev/suspend": snapshotId }),
          }),
        }),
        undefined,
        undefined,
        undefined,
        undefined,
        expect.any(String)
      );
    } finally {
      await workload.stop();
      gate.closeAllConnections();
      await new Promise<void>((resolve) => gate.close(() => resolve()));
      await engine.quit();
      await prisma.$disconnect();
      await (await import("~/db.server")).prisma.$disconnect();
    }
  },
  60_000
);
