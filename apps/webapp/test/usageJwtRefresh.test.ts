import { RunEngine } from "@internal/run-engine";
import { PostgresRunStore } from "@internal/run-store";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { SignJWT, jwtVerify } from "jose";
import { expect } from "vitest";
import { refreshUsageJwtOnHeartbeat } from "~/v3/services/worker/usageJwtRefresh.server";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import { seedTestRun } from "./helpers/seedTestRun";

// Catches: a heartbeat from another worker/runner, attempt or tenant minting a billing credential.
containerTest(
  "billing renewal binds platform pricing to the current owned attempt",
  async ({ prisma, redisOptions }) => {
    const { environment } = await seedTestEnvironment(prisma);
    const { run } = await seedTestRun(prisma, {
      environmentId: environment.id,
      projectId: environment.projectId,
    });
    await prisma.taskRun.update({
      where: { id: run.id },
      data: { attemptNumber: 2, status: "EXECUTING", machinePreset: "large-1x" },
    });
    const snapshot = await prisma.taskRunExecutionSnapshot.create({
      data: {
        runId: run.id,
        executionStatus: "EXECUTING",
        description: "Executing",
        runStatus: "EXECUTING",
        attemptNumber: 2,
        workerId: "worker_owner",
        runnerId: "runner_owner",
        environmentId: environment.id,
        environmentType: environment.type,
        projectId: environment.projectId,
        organizationId: environment.organizationId,
      },
    });
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const engine = new RunEngine({
      prisma,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 1, pollIntervalMs: 100 },
      queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
      runLock: { redis: redisOptions },
      machines: {
        defaultMachine: "small-1x",
        machines: {
          "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          "large-1x": { name: "large-1x", cpu: 4, memory: 8, centsPerMs: 0.0008 },
        },
        baseCostInCents: 0.0001,
      },
      tracer: trace.getTracer("billing-refresh-test"),
    });
    const secret = new TextEncoder().encode("test-billing-signing-key");
    const request: Parameters<typeof refreshUsageJwtOnHeartbeat>[0] = {
      report: { expiresAt: Math.floor(Date.now() / 1_000) - 7_200, attemptNumber: 2 },
      runId: run.id,
      snapshotId: snapshot.id,
      environmentId: environment.id,
      workerId: "worker_owner",
      runnerId: "runner_owner",
      store,
      resolveContext: (id) => engine.resolveTaskRunContext(id),
      sign: (identity, claims) =>
        new SignJWT({
          ...claims,
          environment_id: identity.id,
          org_id: identity.organizationId,
          project_id: identity.projectId,
        })
          .setProtectedHeader({ alg: "HS256" })
          .setExpirationTime("1h")
          .sign(secret),
    };

    try {
      const jwt = await refreshUsageJwtOnHeartbeat(request);
      const { payload } = await jwtVerify(jwt!, secret);
      expect(payload).toMatchObject({
        run_id: run.id,
        usage_attempt: "2",
        usage_auth: "control-plane-v1",
        environment_id: environment.id,
        org_id: environment.organizationId,
        project_id: environment.projectId,
        machine_preset: "large-1x",
        environment_type: "development",
        region: "local",
      });
      for (const override of [
        { workerId: "another_worker" },
        { runnerId: "another_runner" },
        { environmentId: "another_environment" },
        { environmentId: undefined },
        { projectId: "another_project" },
        { snapshotId: "stale_snapshot" },
        { report: { expiresAt: 0, attemptNumber: 1 } },
      ]) {
        await expect(refreshUsageJwtOnHeartbeat({ ...request, ...override })).rejects.toThrow();
      }
      const { waitpoint } = await engine.createManualWaitpoint({
        runId: run.id,
        environmentId: environment.id,
        projectId: environment.projectId,
      });
      const blocked = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: waitpoint.id,
        projectId: environment.projectId,
        organizationId: environment.organizationId,
      });
      request.snapshotId = blocked.id;
      await expect(refreshUsageJwtOnHeartbeat(request)).resolves.toEqual(expect.any(String));
      await engine.completeWaitpoint({ id: waitpoint.id });
      await expect
        .poll(async () => (await store.findLatestExecutionSnapshot(run.id))?.executionStatus, {
          timeout: 10_000,
        })
        .toBe("EXECUTING");
      request.snapshotId = (await store.findLatestExecutionSnapshot(run.id))!.id;
      await expect(refreshUsageJwtOnHeartbeat(request)).resolves.toEqual(expect.any(String));

      await prisma.taskRunExecutionSnapshot.update({
        where: { id: request.snapshotId },
        data: { executionStatus: "FINISHED", runStatus: "COMPLETED_SUCCESSFULLY" },
      });
      await expect(refreshUsageJwtOnHeartbeat(request)).rejects.toThrow();
    } finally {
      await engine.quit();
    }
  }
);
