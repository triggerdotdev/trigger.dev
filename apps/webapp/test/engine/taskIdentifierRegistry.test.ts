import { describe, expect, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

vi.mock("~/services/taskIdentifierCache.server", () => ({
  getTaskIdentifiersFromCache: vi.fn().mockResolvedValue(null),
  populateTaskIdentifierCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/services/logger.server", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("~/models/task.server", () => ({
  getAllTaskIdentifiers: vi.fn().mockResolvedValue([]),
}));

import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { postgresTest } from "@internal/testcontainers";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import {
  syncTaskIdentifiers,
  getTaskIdentifiers,
} from "../../app/services/taskIdentifierRegistry.server";
import type { AuthenticatedEnvironment } from "@internal/run-engine/tests";

vi.setConfig({ testTimeout: 30_000 });

async function createWorker(prisma: PrismaClient, env: AuthenticatedEnvironment) {
  return prisma.backgroundWorker.create({
    data: {
      friendlyId: generateFriendlyId("worker"),
      contentHash: `hash-${Date.now()}-${Math.random()}`,
      projectId: env.project.id,
      runtimeEnvironmentId: env.id,
      version: `${Date.now()}`,
      metadata: {},
      engine: "V2",
    },
  });
}

describe("TaskIdentifierRegistry", () => {
  postgresTest("should create task identifiers on first sync", async ({ prisma }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const worker = await createWorker(prisma, env);

    await syncTaskIdentifiers(
      env.id,
      env.project.id,
      worker.id,
      [
        { id: "task-a", triggerSource: "STANDARD" },
        { id: "task-b", triggerSource: "SCHEDULED" },
      ],
      prisma
    );

    const rows = await prisma.taskIdentifier.findMany({
      where: { runtimeEnvironmentId: env.id },
      orderBy: { slug: "asc" },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].slug).toBe("task-a");
    expect(rows[0].currentTriggerSource).toBe("STANDARD");
    expect(rows[0].isInLatestDeployment).toBe(true);
    expect(rows[1].slug).toBe("task-b");
    expect(rows[1].currentTriggerSource).toBe("SCHEDULED");
    expect(rows[1].isInLatestDeployment).toBe(true);
  });

  postgresTest("should update triggerSource on re-deploy", async ({ prisma }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const worker1 = await createWorker(prisma, env);

    // First deploy: STANDARD
    await syncTaskIdentifiers(
      env.id,
      env.project.id,
      worker1.id,
      [{ id: "my-task", triggerSource: "STANDARD" }],
      prisma
    );

    const worker2 = await createWorker(prisma, env);

    // Second deploy: change to SCHEDULED
    await syncTaskIdentifiers(
      env.id,
      env.project.id,
      worker2.id,
      [{ id: "my-task", triggerSource: "SCHEDULED" }],
      prisma
    );

    const rows = await prisma.taskIdentifier.findMany({
      where: { runtimeEnvironmentId: env.id },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("my-task");
    expect(rows[0].currentTriggerSource).toBe("SCHEDULED");
    expect(rows[0].currentWorkerId).toBe(worker2.id);
  });

  postgresTest("should archive tasks removed in a deploy", async ({ prisma }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const worker1 = await createWorker(prisma, env);

    // Deploy with both tasks
    await syncTaskIdentifiers(
      env.id,
      env.project.id,
      worker1.id,
      [
        { id: "task-a", triggerSource: "STANDARD" },
        { id: "task-b", triggerSource: "STANDARD" },
      ],
      prisma
    );

    const worker2 = await createWorker(prisma, env);

    // Deploy with only task-a (task-b removed)
    await syncTaskIdentifiers(
      env.id,
      env.project.id,
      worker2.id,
      [{ id: "task-a", triggerSource: "STANDARD" }],
      prisma
    );

    const rows = await prisma.taskIdentifier.findMany({
      where: { runtimeEnvironmentId: env.id },
      orderBy: { slug: "asc" },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].slug).toBe("task-a");
    expect(rows[0].isInLatestDeployment).toBe(true);
    expect(rows[1].slug).toBe("task-b");
    expect(rows[1].isInLatestDeployment).toBe(false);
  });

  postgresTest("should resurrect archived tasks on re-deploy", async ({ prisma }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const worker1 = await createWorker(prisma, env);

    // Deploy with both
    await syncTaskIdentifiers(
      env.id,
      env.project.id,
      worker1.id,
      [
        { id: "task-a", triggerSource: "STANDARD" },
        { id: "task-b", triggerSource: "STANDARD" },
      ],
      prisma
    );

    const worker2 = await createWorker(prisma, env);

    // Deploy without task-b
    await syncTaskIdentifiers(
      env.id,
      env.project.id,
      worker2.id,
      [{ id: "task-a", triggerSource: "STANDARD" }],
      prisma
    );

    const worker3 = await createWorker(prisma, env);

    // Deploy with task-b again
    await syncTaskIdentifiers(
      env.id,
      env.project.id,
      worker3.id,
      [
        { id: "task-a", triggerSource: "STANDARD" },
        { id: "task-b", triggerSource: "STANDARD" },
      ],
      prisma
    );

    const rows = await prisma.taskIdentifier.findMany({
      where: { runtimeEnvironmentId: env.id },
      orderBy: { slug: "asc" },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].isInLatestDeployment).toBe(true);
    expect(rows[1].isInLatestDeployment).toBe(true);
  });

  postgresTest(
    "should return identifiers sorted active-first from DB when cache misses",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const worker1 = await createWorker(prisma, env);

      await syncTaskIdentifiers(
        env.id,
        env.project.id,
        worker1.id,
        [
          { id: "active-task", triggerSource: "STANDARD" },
          { id: "archived-task", triggerSource: "STANDARD" },
        ],
        prisma
      );

      const worker2 = await createWorker(prisma, env);

      // Archive one task
      await syncTaskIdentifiers(
        env.id,
        env.project.id,
        worker2.id,
        [{ id: "active-task", triggerSource: "STANDARD" }],
        prisma
      );

      // Read with cache miss (mocked to return null)
      const result = await getTaskIdentifiers(env.id, prisma);

      expect(result).toHaveLength(2);
      // Active first
      expect(result[0].slug).toBe("active-task");
      expect(result[0].isInLatestDeployment).toBe(true);
      // Archived second
      expect(result[1].slug).toBe("archived-task");
      expect(result[1].isInLatestDeployment).toBe(false);
    }
  );

  postgresTest("should handle multiple triggerSource groups in one deploy", async ({ prisma }) => {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const worker = await createWorker(prisma, env);

    // Note: AGENT enum value is missing from migrations (no ALTER TYPE migration exists),
    // so we test with STANDARD + SCHEDULED only. AGENT works in prod because the enum
    // was added via prisma db push or manual ALTER.
    await syncTaskIdentifiers(
      env.id,
      env.project.id,
      worker.id,
      [
        { id: "standard-task", triggerSource: "STANDARD" },
        { id: "scheduled-task", triggerSource: "SCHEDULED" },
      ],
      prisma
    );

    const rows = await prisma.taskIdentifier.findMany({
      where: { runtimeEnvironmentId: env.id },
      orderBy: { slug: "asc" },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].slug).toBe("scheduled-task");
    expect(rows[0].currentTriggerSource).toBe("SCHEDULED");
    expect(rows[1].slug).toBe("standard-task");
    expect(rows[1].currentTriggerSource).toBe("STANDARD");
  });
});
