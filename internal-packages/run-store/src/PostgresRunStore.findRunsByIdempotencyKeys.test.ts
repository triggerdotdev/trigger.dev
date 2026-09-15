import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
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
  }
) {
  await prisma.taskRun.create({
    data: {
      friendlyId: params.friendlyId,
      taskIdentifier: params.taskIdentifier,
      idempotencyKey: params.idempotencyKey,
      idempotencyKeyExpiresAt: params.idempotencyKeyExpiresAt ?? null,
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
});
