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
    expectAssignedTime(created, 18 * 60_000);

    const retrieveResponse = await server.webapp.fetch(`/api/v1/schedules/${created.id}`, {
      headers: authHeaders(apiKey),
    });
    expect(retrieveResponse.status).toBe(200);
    const retrieved = await retrieveResponse.json();
    expect(retrieved).toMatchObject({
      id: created.id,
      window: "30%",
    });
    expectAssignedTime(retrieved, 18 * 60_000);

    const listResponse = await server.webapp.fetch("/api/v1/schedules", {
      headers: authHeaders(apiKey),
    });
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json();
    expect(listed.data[0]).toMatchObject({ id: created.id });
    expectAssignedTime(listed.data[0], 18 * 60_000);

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
    const updated = await updateResponse.json();
    expect(updated).toMatchObject({
      id: created.id,
      window: "2h",
    });
    expectAssignedTime(updated, 2 * 60 * 60_000);

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

    const deactivateResponse = await server.webapp.fetch(
      `/api/v1/schedules/${created.id}/deactivate`,
      { method: "POST", headers: authHeaders(apiKey) }
    );
    expect(deactivateResponse.status).toBe(200);
    await expect(deactivateResponse.json()).resolves.toMatchObject({
      active: false,
      nextRun: null,
      nextRunEffectiveAt: null,
    });

    const activateResponse = await server.webapp.fetch(`/api/v1/schedules/${created.id}/activate`, {
      method: "POST",
      headers: authHeaders(apiKey),
    });
    expect(activateResponse.status).toBe(200);
    const activated = await activateResponse.json();
    expect(activated.active).toBe(true);
    expectAssignedTime(activated, 60_000);

    const stored = await server.prisma.taskSchedule.findUniqueOrThrow({
      where: { friendlyId: created.id },
      select: { windowDurationSeconds: true, windowPercentage: true },
    });
    expect(stored).toEqual({
      windowDurationSeconds: null,
      windowPercentage: null,
    });
  });

  it("accepts zero windows and absolute windows longer than the cron interval", async () => {
    const server = getTestServer();
    const { apiKey, project, environment } = await seedTestEnvironment(server.prisma);
    await seedScheduledTask(server.prisma, project.id, environment.id);

    const windows = [
      ["0m", "0m"],
      ["0h", "0m"],
      ["0%", "0%"],
      ["2h", "2h"],
    ] as const;

    for (const [index, [window, expectedWindow]] of windows.entries()) {
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
      await expect(response.json()).resolves.toMatchObject({ window: expectedWindow });
    }
  });

  it("returns safe errors for invalid windows", async () => {
    const server = getTestServer();
    const { apiKey, project, environment } = await seedTestEnvironment(server.prisma);
    await seedScheduledTask(server.prisma, project.id, environment.id);

    const invalidWindows = [30, "30.5%", "1d", "25h"];

    for (const [index, window] of invalidWindows.entries()) {
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

      expect(response.status).toBe(400);
    }
  });
});

function expectAssignedTime(
  schedule: { nextRun: string; nextRunEffectiveAt: string },
  maximumDelayMs: number
) {
  const nominalAt = new Date(schedule.nextRun).getTime();
  const effectiveAt = new Date(schedule.nextRunEffectiveAt).getTime();

  expect(effectiveAt).toBeGreaterThanOrEqual(nominalAt);
  expect(effectiveAt).toBeLessThan(nominalAt + maximumDelayMs);
}

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
