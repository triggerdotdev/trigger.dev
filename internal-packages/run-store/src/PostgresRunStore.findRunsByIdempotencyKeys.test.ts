import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient, TaskRunStatus } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";

async function seedEnvironment(prisma: PrismaClient) {
  const organization = await prisma.organization.create({
    data: { title: "Test Organization", slug: "test-organization" },
  });
  const project = await prisma.project.create({
    data: {
      name: "Test Project",
      slug: "test-project",
      externalRef: "proj_1234",
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: "tr_dev_apikey",
      pkApiKey: "pk_dev_apikey",
      shortcode: "short_code",
    },
  });
  return { organization, project, environment };
}

async function createRun(
  prisma: PrismaClient,
  params: {
    runtimeEnvironmentId: string;
    projectId: string;
    friendlyId: string;
    taskIdentifier: string;
    idempotencyKey: string;
    idempotencyKeyExpiresAt?: Date;
    status?: TaskRunStatus;
  }
) {
  await prisma.taskRun.create({
    data: {
      friendlyId: params.friendlyId,
      taskIdentifier: params.taskIdentifier,
      idempotencyKey: params.idempotencyKey,
      idempotencyKeyExpiresAt: params.idempotencyKeyExpiresAt ?? null,
      status: params.status ?? "PENDING",
      payload: "{}",
      payloadType: "application/json",
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      projectId: params.projectId,
      queue: `task/${params.taskIdentifier}`,
      traceId: `trace_${params.friendlyId}`,
      spanId: `span_${params.friendlyId}`,
      engine: "V2",
    },
  });
}

describe("PostgresRunStore.findRunsByIdempotencyKeys", () => {
  postgresTest("resolves multiple keys, scoped to (env, task)", async ({ prisma }) => {
    const { project, environment } = await seedEnvironment(prisma);
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

    const expiresAt = new Date("2999-01-01T00:00:00.000Z");
    await createRun(prisma, {
      runtimeEnvironmentId: environment.id,
      projectId: project.id,
      friendlyId: "run_a1",
      taskIdentifier: "task-a",
      idempotencyKey: "idem-1",
      idempotencyKeyExpiresAt: expiresAt,
    });
    await createRun(prisma, {
      runtimeEnvironmentId: environment.id,
      projectId: project.id,
      friendlyId: "run_a2",
      taskIdentifier: "task-a",
      idempotencyKey: "idem-2",
    });
    await createRun(prisma, {
      runtimeEnvironmentId: environment.id,
      projectId: project.id,
      friendlyId: "run_b1",
      taskIdentifier: "task-b",
      idempotencyKey: "idem-1",
    });

    const rows = await store.findRunsByIdempotencyKeys({
      runtimeEnvironmentId: environment.id,
      taskIdentifier: "task-a",
      idempotencyKeys: ["idem-1", "idem-2", "does-not-exist"],
    });

    const byKey = new Map(rows.map((r) => [r.idempotencyKey, r]));
    expect(rows).toHaveLength(2);
    expect(byKey.get("idem-1")?.friendlyId).toBe("run_a1");
    expect(byKey.get("idem-2")?.friendlyId).toBe("run_a2");
    expect(rows.map((r) => r.friendlyId)).not.toContain("run_b1");
    expect(byKey.get("idem-1")?.idempotencyKeyExpiresAt).toBeInstanceOf(Date);
    expect(byKey.get("idem-1")?.idempotencyKeyExpiresAt?.toISOString()).toBe(
      expiresAt.toISOString()
    );
    expect(byKey.get("idem-2")?.idempotencyKeyExpiresAt).toBeNull();
    // status must be returned so callers can check shouldIdempotencyKeyBeCleared
    expect(byKey.get("idem-1")?.status).toBe("PENDING");
    expect(byKey.get("idem-2")?.status).toBe("PENDING");
  });

  postgresTest("short-circuits on an empty key list without querying", async ({ prisma }) => {
    const { environment } = await seedEnvironment(prisma);
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

    const rows = await store.findRunsByIdempotencyKeys({
      runtimeEnvironmentId: environment.id,
      taskIdentifier: "task-a",
      idempotencyKeys: [],
    });

    expect(rows).toEqual([]);
  });

  postgresTest(
    "returns status for runs in failure states (CRASHED, SYSTEM_FAILURE, TIMED_OUT, EXPIRED, COMPLETED_WITH_ERRORS, INTERRUPTED)",
    async ({ prisma }) => {
      const { project, environment } = await seedEnvironment(prisma);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

      const failureStatuses: TaskRunStatus[] = [
        "CRASHED",
        "SYSTEM_FAILURE",
        "TIMED_OUT",
        "EXPIRED",
        "COMPLETED_WITH_ERRORS",
        "INTERRUPTED",
      ];

      for (let i = 0; i < failureStatuses.length; i++) {
        await createRun(prisma, {
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          friendlyId: `run_fail_${i}`,
          taskIdentifier: "task-a",
          idempotencyKey: `idem-fail-${i}`,
          status: failureStatuses[i],
        });
      }

      const rows = await store.findRunsByIdempotencyKeys({
        runtimeEnvironmentId: environment.id,
        taskIdentifier: "task-a",
        idempotencyKeys: failureStatuses.map((_, i) => `idem-fail-${i}`),
      });

      expect(rows).toHaveLength(failureStatuses.length);

      const byKey = new Map(rows.map((r) => [r.idempotencyKey, r]));
      for (let i = 0; i < failureStatuses.length; i++) {
        const row = byKey.get(`idem-fail-${i}`);
        expect(row).toBeDefined();
        expect(row?.status).toBe(failureStatuses[i]);
        expect(row?.friendlyId).toBe(`run_fail_${i}`);
      }
    }
  );

  postgresTest("returns status for a successfully completed run", async ({ prisma }) => {
    const { project, environment } = await seedEnvironment(prisma);
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

    await createRun(prisma, {
      runtimeEnvironmentId: environment.id,
      projectId: project.id,
      friendlyId: "run_success",
      taskIdentifier: "task-a",
      idempotencyKey: "idem-success",
      status: "COMPLETED_SUCCESSFULLY",
    });

    const rows = await store.findRunsByIdempotencyKeys({
      runtimeEnvironmentId: environment.id,
      taskIdentifier: "task-a",
      idempotencyKeys: ["idem-success"],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("COMPLETED_SUCCESSFULLY");
  });
});
