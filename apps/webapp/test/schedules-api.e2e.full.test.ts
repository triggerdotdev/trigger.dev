import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { seedTestEnvironment } from "./helpers/seedTestEnvironment";
import { getTestServer } from "./helpers/sharedTestServer";

const TASK_IDENTIFIER = "scheduled-task";

describe("Schedules API windows", () => {
  it("creates, retrieves, updates, and clears a window", async () => {
    const server = getTestServer();
    const { apiKey, project, environment } = await seedTestEnvironment(server.prisma);
    await seedScheduledTask(server.prisma, project.id, environment.id);

    const createResponse = await server.webapp.fetch("/api/v1/schedules", {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        task: TASK_IDENTIFIER,
        cron: "0 * * * *",
        deduplicationKey: "window-lifecycle",
        window: "30%",
      }),
    });

    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    expect(created).toMatchObject({
      task: TASK_IDENTIFIER,
      timezone: "UTC",
      window: "30%",
    });

    const retrieveResponse = await server.webapp.fetch(`/api/v1/schedules/${created.id}`, {
      headers: authHeaders(apiKey),
    });
    expect(retrieveResponse.status).toBe(200);
    await expect(retrieveResponse.json()).resolves.toMatchObject({
      id: created.id,
      window: "30%",
    });

    const updateResponse = await server.webapp.fetch(`/api/v1/schedules/${created.id}`, {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        task: TASK_IDENTIFIER,
        cron: "0 0 * * *",
        window: "2h",
      }),
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      id: created.id,
      window: "2h",
    });

    const clearResponse = await server.webapp.fetch(`/api/v1/schedules/${created.id}`, {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        task: TASK_IDENTIFIER,
        cron: "0 0 * * *",
      }),
    });
    expect(clearResponse.status).toBe(200);
    const cleared = await clearResponse.json();
    expect(cleared.id).toBe(created.id);
    expect(cleared).not.toHaveProperty("window");

    const stored = await server.prisma.taskSchedule.findUniqueOrThrow({
      where: { friendlyId: created.id },
      select: { windowDurationSeconds: true, windowPercentage: true },
    });
    expect(stored).toEqual({
      windowDurationSeconds: null,
      windowPercentage: null,
    });
  });

  it("accepts zero duration and percentage windows", async () => {
    const server = getTestServer();
    const { apiKey, project, environment } = await seedTestEnvironment(server.prisma);
    await seedScheduledTask(server.prisma, project.id, environment.id);

    for (const [index, window] of ["0m", "0h", "0d", "0%"].entries()) {
      const response = await server.webapp.fetch("/api/v1/schedules", {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({
          task: TASK_IDENTIFIER,
          cron: "0 * * * *",
          deduplicationKey: `zero-window-${index}`,
          window,
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        window: window === "0%" ? "0%" : "0m",
      });
    }
  });

  it("returns safe errors for invalid windows", async () => {
    const server = getTestServer();
    const { apiKey, project, environment } = await seedTestEnvironment(server.prisma);
    await seedScheduledTask(server.prisma, project.id, environment.id);

    const invalidRequests = [
      { window: 30, expectedStatus: 400 },
      { window: "30.5%", expectedStatus: 422 },
      { window: "2h", expectedStatus: 422 },
    ];

    for (const [index, { window, expectedStatus }] of invalidRequests.entries()) {
      const response = await server.webapp.fetch("/api/v1/schedules", {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({
          task: TASK_IDENTIFIER,
          cron: "0 * * * *",
          deduplicationKey: `invalid-window-${index}`,
          window,
        }),
      });

      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toHaveProperty("error");
    }
  });
});

function authHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function seedScheduledTask(
  prisma: PrismaClient,
  projectId: string,
  runtimeEnvironmentId: string
) {
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${runtimeEnvironmentId}`,
      contentHash: `hash_${runtimeEnvironmentId}`,
      version: "20260811.1",
      metadata: {},
      projectId,
      runtimeEnvironmentId,
    },
  });

  await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${runtimeEnvironmentId}`,
      slug: TASK_IDENTIFIER,
      filePath: "src/trigger/scheduled-task.ts",
      workerId: worker.id,
      projectId,
      runtimeEnvironmentId,
      triggerSource: "SCHEDULED",
    },
  });
}
