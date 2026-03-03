import { describe, expect, vi } from "vitest";

// Mock the db prisma client (required for webapp service imports)
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEntitlement: vi.fn(),
  };
});

import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { postgresTest } from "@internal/testcontainers";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { DeadLetterManagementService } from "../../app/v3/services/events/deadLetterManagement.server";
import { ServiceValidationError } from "../../app/v3/services/common.server";

vi.setConfig({ testTimeout: 120_000 });

/**
 * Helper: create a TaskRun in the database so DeadLetterEvent can reference it.
 */
async function createTaskRun(
  prisma: any,
  env: { id: string; projectId: string; organization: { id: string } },
  taskIdentifier: string
) {
  const runId = generateFriendlyId("run");
  return prisma.taskRun.create({
    data: {
      id: runId,
      friendlyId: runId,
      number: 1,
      taskIdentifier,
      payload: JSON.stringify({ test: true }),
      payloadType: "application/json",
      traceId: "trace_" + runId,
      spanId: "span_" + runId,
      queue: `task/${taskIdentifier}`,
      status: "COMPLETED_WITH_ERRORS",
      runtimeEnvironmentId: env.id,
      projectId: env.projectId,
      organizationId: env.organization.id,
      engine: "V2",
    },
  });
}

/**
 * Helper: create a DeadLetterEvent directly in the database.
 */
async function createDeadLetterEvent(
  prisma: any,
  env: { id: string; projectId: string },
  run: { id: string },
  overrides: {
    eventType?: string;
    status?: "PENDING" | "RETRIED" | "DISCARDED";
    payload?: object;
    createdAt?: Date;
  } = {}
) {
  const dleId = generateFriendlyId("dle");
  return prisma.deadLetterEvent.create({
    data: {
      id: dleId,
      friendlyId: dleId,
      eventType: overrides.eventType ?? "test.event",
      payload: overrides.payload ?? { key: "value" },
      taskSlug: "test-task",
      failedRunId: run.id,
      error: { message: "test error" },
      attemptCount: 1,
      sourceEventId: "src_" + dleId,
      projectId: env.projectId,
      environmentId: env.id,
      status: overrides.status ?? "PENDING",
      ...(overrides.createdAt && { createdAt: overrides.createdAt }),
    },
  });
}

describe("DeadLetterManagementService", () => {
  postgresTest(
    "List DLQ entries with pagination",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Create 5 DLQ entries, each needs its own TaskRun (foreign key)
      const entries = [];
      for (let i = 0; i < 5; i++) {
        const run = await createTaskRun(prisma, env, `task-${i}`);
        const dle = await createDeadLetterEvent(prisma, env, run, {
          eventType: "paginated.event",
          // Stagger createdAt so ordering is deterministic
          createdAt: new Date(Date.now() - (4 - i) * 1000),
        });
        entries.push(dle);
      }

      const service = new DeadLetterManagementService(prisma);

      // Page 1: limit 2
      const page1 = await service.list({
        projectId: env.projectId,
        environmentId: env.id,
        limit: 2,
      });

      expect(page1.data).toHaveLength(2);
      expect(page1.pagination.hasMore).toBe(true);
      expect(page1.pagination.cursor).toBeDefined();
      expect(page1.pagination.cursor).not.toBeNull();

      // Page 2: use cursor from page 1
      const page2 = await service.list({
        projectId: env.projectId,
        environmentId: env.id,
        limit: 2,
        cursor: page1.pagination.cursor!,
      });

      expect(page2.data).toHaveLength(2);
      expect(page2.pagination.hasMore).toBe(true);

      // Page 3: last item
      const page3 = await service.list({
        projectId: env.projectId,
        environmentId: env.id,
        limit: 2,
        cursor: page2.pagination.cursor!,
      });

      expect(page3.data).toHaveLength(1);
      expect(page3.pagination.hasMore).toBe(false);
      expect(page3.pagination.cursor).toBeNull();

      // All 5 entries across all pages, no duplicates
      const allIds = [
        ...page1.data.map((d: any) => d.id),
        ...page2.data.map((d: any) => d.id),
        ...page3.data.map((d: any) => d.id),
      ];
      expect(new Set(allIds).size).toBe(5);
    }
  );

  postgresTest(
    "List with eventType filter",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Create entries with different event types
      const run1 = await createTaskRun(prisma, env, "task-alpha");
      const run2 = await createTaskRun(prisma, env, "task-beta");
      const run3 = await createTaskRun(prisma, env, "task-gamma");

      await createDeadLetterEvent(prisma, env, run1, { eventType: "order.created" });
      await createDeadLetterEvent(prisma, env, run2, { eventType: "user.signed_up" });
      await createDeadLetterEvent(prisma, env, run3, { eventType: "order.created" });

      const service = new DeadLetterManagementService(prisma);

      const orderEvents = await service.list({
        projectId: env.projectId,
        environmentId: env.id,
        eventType: "order.created",
      });

      expect(orderEvents.data).toHaveLength(2);
      expect(orderEvents.data.every((d: any) => d.eventType === "order.created")).toBe(true);

      const userEvents = await service.list({
        projectId: env.projectId,
        environmentId: env.id,
        eventType: "user.signed_up",
      });

      expect(userEvents.data).toHaveLength(1);
      expect(userEvents.data[0].eventType).toBe("user.signed_up");
    }
  );

  postgresTest(
    "List with status filter",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const run1 = await createTaskRun(prisma, env, "task-p1");
      const run2 = await createTaskRun(prisma, env, "task-p2");
      const run3 = await createTaskRun(prisma, env, "task-r1");

      await createDeadLetterEvent(prisma, env, run1, { status: "PENDING" });
      await createDeadLetterEvent(prisma, env, run2, { status: "PENDING" });
      await createDeadLetterEvent(prisma, env, run3, { status: "RETRIED" });

      const service = new DeadLetterManagementService(prisma);

      const pendingOnly = await service.list({
        projectId: env.projectId,
        environmentId: env.id,
        status: "PENDING",
      });

      expect(pendingOnly.data).toHaveLength(2);
      expect(pendingOnly.data.every((d: any) => d.status === "PENDING")).toBe(true);

      const retriedOnly = await service.list({
        projectId: env.projectId,
        environmentId: env.id,
        status: "RETRIED",
      });

      expect(retriedOnly.data).toHaveLength(1);
      expect(retriedOnly.data[0].status).toBe("RETRIED");
    }
  );

  postgresTest(
    "Discard marks entry as DISCARDED",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const run = await createTaskRun(prisma, env, "discard-task");
      const dle = await createDeadLetterEvent(prisma, env, run, {
        eventType: "invoice.failed",
        status: "PENDING",
      });

      const service = new DeadLetterManagementService(prisma);

      const result = await service.discard(dle.id, env);

      expect(result.id).toBe(dle.id);
      expect(result.status).toBe("DISCARDED");

      // Verify in DB
      const updated = await prisma.deadLetterEvent.findUnique({
        where: { id: dle.id },
      });

      expect(updated).toBeDefined();
      expect(updated!.status).toBe("DISCARDED");
      expect(updated!.processedAt).toBeDefined();
      expect(updated!.processedAt).not.toBeNull();
    }
  );

  postgresTest(
    "Discard nonexistent ID returns error",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const service = new DeadLetterManagementService(prisma);

      await expect(service.discard("dle_nonexistent_fake_id", env)).rejects.toThrow(
        ServiceValidationError
      );

      await expect(service.discard("dle_nonexistent_fake_id", env)).rejects.toThrow(
        "Dead letter event not found or already processed"
      );
    }
  );
});
