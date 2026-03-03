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
import { DeadLetterService } from "../../app/v3/services/events/deadLetterService.server";

vi.setConfig({ testTimeout: 120_000 });

/**
 * Helper: create a TaskRun in the database with the given overrides.
 * Returns the created TaskRun record.
 */
async function createTaskRun(
  prisma: any,
  env: { id: string; projectId: string; organization: { id: string } },
  overrides: {
    taskIdentifier?: string;
    payload?: string;
    metadata?: string | null;
    status?: string;
  } = {}
) {
  const runId = generateFriendlyId("run");
  return prisma.taskRun.create({
    data: {
      id: runId,
      friendlyId: runId,
      number: 1,
      taskIdentifier: overrides.taskIdentifier ?? "test-task",
      payload: overrides.payload ?? JSON.stringify({ hello: "world" }),
      payloadType: "application/json",
      traceId: "trace_test_" + runId,
      spanId: "span_test_" + runId,
      queue: "task/test-task",
      status: overrides.status ?? "COMPLETED_WITH_ERRORS",
      runtimeEnvironmentId: env.id,
      projectId: env.projectId,
      organizationId: env.organization.id,
      metadata: overrides.metadata ?? null,
      engine: "V2",
    },
  });
}

describe("DeadLetterService", () => {
  postgresTest(
    "Failed event-triggered run creates DLQ entry",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const eventMetadata = {
        $$event: {
          eventId: "evt_abc123",
          eventType: "order.created",
          sourceEventId: "src_evt_001",
        },
      };

      const run = await createTaskRun(prisma, env, {
        taskIdentifier: "process-order",
        payload: JSON.stringify({ orderId: "order_999" }),
        metadata: JSON.stringify(eventMetadata),
        status: "COMPLETED_WITH_ERRORS",
      });

      const service = new DeadLetterService(prisma);
      await service.handleFailedRun(run, { message: "Task timed out" });

      const dleEntries = await prisma.deadLetterEvent.findMany({
        where: { failedRunId: run.id },
      });

      expect(dleEntries).toHaveLength(1);
      expect(dleEntries[0].eventType).toBe("order.created");
      expect(dleEntries[0].taskSlug).toBe("process-order");
    }
  );

  postgresTest(
    "Non-event run does NOT create DLQ entry",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // No $$event in metadata
      const run = await createTaskRun(prisma, env, {
        taskIdentifier: "plain-task",
        metadata: JSON.stringify({ someKey: "someValue" }),
        status: "COMPLETED_WITH_ERRORS",
      });

      const service = new DeadLetterService(prisma);
      await service.handleFailedRun(run, { message: "Something went wrong" });

      const dleEntries = await prisma.deadLetterEvent.findMany({
        where: { failedRunId: run.id },
      });

      expect(dleEntries).toHaveLength(0);
    }
  );

  postgresTest(
    "DLQ entry has correct fields",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const eventMetadata = {
        $$event: {
          eventId: "evt_field_test",
          eventType: "user.signed_up",
          sourceEventId: "src_evt_field",
        },
      };

      const run = await createTaskRun(prisma, env, {
        taskIdentifier: "welcome-email",
        payload: JSON.stringify({ userId: "usr_42", email: "test@example.com" }),
        metadata: JSON.stringify(eventMetadata),
        status: "COMPLETED_WITH_ERRORS",
      });

      const errorObj = { message: "SMTP timeout", code: "ETIMEOUT" };

      const service = new DeadLetterService(prisma);
      await service.handleFailedRun(run, errorObj);

      const dle = await prisma.deadLetterEvent.findFirst({
        where: { failedRunId: run.id },
      });

      expect(dle).toBeDefined();
      expect(dle!.eventType).toBe("user.signed_up");
      expect(dle!.payload).toEqual({ userId: "usr_42", email: "test@example.com" });
      expect(dle!.error).toEqual(errorObj);
      expect(dle!.taskSlug).toBe("welcome-email");
      expect(dle!.failedRunId).toBe(run.id);
      expect(dle!.sourceEventId).toBe("src_evt_field");
      expect(dle!.projectId).toBe(env.projectId);
      expect(dle!.environmentId).toBe(env.id);
      expect(dle!.status).toBe("PENDING");
      expect(dle!.friendlyId).toMatch(/^dle_/);
    }
  );

  postgresTest(
    "Multiple failures create separate DLQ entries",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const service = new DeadLetterService(prisma);

      // First failed run
      const run1 = await createTaskRun(prisma, env, {
        taskIdentifier: "task-a",
        payload: JSON.stringify({ item: 1 }),
        metadata: JSON.stringify({
          $$event: {
            eventId: "evt_multi_1",
            eventType: "item.created",
            sourceEventId: "src_multi_1",
          },
        }),
        status: "COMPLETED_WITH_ERRORS",
      });

      // Second failed run
      const run2 = await createTaskRun(prisma, env, {
        taskIdentifier: "task-b",
        payload: JSON.stringify({ item: 2 }),
        metadata: JSON.stringify({
          $$event: {
            eventId: "evt_multi_2",
            eventType: "item.created",
            sourceEventId: "src_multi_2",
          },
        }),
        status: "COMPLETED_WITH_ERRORS",
      });

      await service.handleFailedRun(run1, { message: "Error 1" });
      await service.handleFailedRun(run2, { message: "Error 2" });

      const allEntries = await prisma.deadLetterEvent.findMany({
        where: {
          projectId: env.projectId,
          environmentId: env.id,
        },
        orderBy: { createdAt: "asc" },
      });

      expect(allEntries).toHaveLength(2);

      const entry1 = allEntries.find((e: any) => e.failedRunId === run1.id);
      const entry2 = allEntries.find((e: any) => e.failedRunId === run2.id);

      expect(entry1).toBeDefined();
      expect(entry2).toBeDefined();
      expect(entry1!.taskSlug).toBe("task-a");
      expect(entry2!.taskSlug).toBe("task-b");
      expect(entry1!.sourceEventId).toBe("src_multi_1");
      expect(entry2!.sourceEventId).toBe("src_multi_2");
    }
  );
});
