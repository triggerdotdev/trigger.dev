import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import type * as Database from "~/db.server";
import { seedTestEnvironment } from "./seedTestEnvironment";

type TokenEnvironment = { id: string; organizationId: string; projectId: string };

export async function assertRunTokenSchedules(
  database: typeof Database,
  tokenFor: (environment: TokenEnvironment, scopes?: string[]) => Promise<string>
) {
  const seed = await seedTestEnvironment(database.prisma);
  await database.prisma.backgroundWorker.create({
    data: {
      projectId: seed.project.id,
      runtimeEnvironmentId: seed.environment.id,
      friendlyId: `worker_${randomBytes(12).toString("hex")}`,
      contentHash: "test",
      version: "1",
      metadata: {},
      engine: "V2",
      tasks: {
        create: {
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
          slug: "test-task",
          friendlyId: `task_${randomBytes(12).toString("hex")}`,
          filePath: "test.ts",
          triggerSource: "SCHEDULED",
        },
      },
    },
  });
  const sibling = await database.prisma.runtimeEnvironment.create({
    data: {
      organizationId: seed.organization.id,
      projectId: seed.project.id,
      type: "STAGING",
      slug: "stg",
      shortcode: "stg",
      apiKey: `${seed.environment.apiKey}_stg`,
      pkApiKey: `${seed.environment.pkApiKey}_stg`,
    },
  });
  const schedule = await database.prisma.taskSchedule.create({
    data: {
      projectId: seed.project.id,
      friendlyId: `sched_${randomBytes(12).toString("hex")}`,
      taskIdentifier: "test-task",
      deduplicationKey: "shared",
      type: "IMPERATIVE",
      active: true,
      generatorExpression: "0 * * * *",
      generatorDescription: "Every hour",
      instances: {
        create: [seed.environment.id, sibling.id].map((environmentId) => ({
          environmentId,
          projectId: seed.project.id,
        })),
      },
    },
  });
  const collection = await import("~/routes/api.v1.schedules");
  const resource = await import("~/routes/api.v1.schedules.$scheduleId");
  const activate = await import("~/routes/api.v1.schedules.$scheduleId.activate");
  const deactivate = await import("~/routes/api.v1.schedules.$scheduleId.deactivate");
  const token = await tokenFor(seed.environment);
  const call = (method: string, bearer = token, body?: Record<string, unknown>) => ({
    request: new Request("https://api.example.com/schedules", {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    params: { scheduleId: schedule.friendlyId },
    context: {},
  });
  // Catches: claiming a sibling's schedule between its row insert and first attachment.
  const inFlight = await database.prisma.taskSchedule.create({
    data: {
      projectId: seed.project.id,
      friendlyId: `sched_${randomBytes(12).toString("hex")}`,
      taskIdentifier: "test-task",
      deduplicationKey: "in-flight",
      type: "IMPERATIVE",
      generatorExpression: "0 * * * *",
      generatorDescription: "Every hour",
    },
  });
  expect(
    (
      await collection.action(
        call("POST", token, {
          task: "test-task",
          cron: "*/15 * * * *",
          deduplicationKey: "in-flight",
        })
      )
    ).status
  ).toBe(422);
  await database.prisma.taskScheduleInstance.create({
    data: { taskScheduleId: inFlight.id, projectId: seed.project.id, environmentId: sibling.id },
  });
  const untouched = await database.prisma.taskSchedule.findFirstOrThrow({
    where: { id: inFlight.id },
    include: { instances: true },
  });
  expect(untouched.generatorExpression).toBe("0 * * * *");
  expect(untouched.instances.map((instance) => instance.environmentId)).toEqual([sibling.id]);

  const detail = await resource.loader(call("GET"));
  expect(detail.status).toBe(200);
  const detailBody = await detail.json();
  if (!("environments" in detailBody)) throw new Error("Schedule detail returned an error");
  expect(detailBody.environments.map((environment) => environment.id)).toEqual([
    seed.environment.id,
  ]);
  const list = await collection.loader(call("GET"));
  if (!("data" in list)) throw new Error(`Schedule listing failed: ${await list.text()}`);
  expect(list.data[0]?.environments.map((e: { id: string }) => e.id)).toEqual([
    seed.environment.id,
  ]);
  expect((await deactivate.action(call("POST"))).status).toBe(404);
  expect((await activate.action(call("POST"))).status).toBe(404);
  expect((await resource.action(call("DELETE")))?.status).toBe(404);
  const update = { task: "test-task", cron: "*/15 * * * *" };
  expect((await resource.action(call("PUT", token, update)))?.status).toBe(422);
  expect(
    (await collection.action(call("POST", token, { ...update, deduplicationKey: "shared" }))).status
  ).toBe(422);
  expect(
    await database.prisma.taskScheduleInstance.count({ where: { taskScheduleId: schedule.id } })
  ).toBe(2);
  const created = await collection.action(
    call("POST", token, { ...update, deduplicationKey: "own" })
  );
  expect(created.status).toBe(200);
  if (!("json" in created)) throw new Error("Schedule creation returned no response body");
  const own = await created.json();
  if (!("id" in own)) throw new Error("Schedule creation returned an error");
  expect(
    (
      await resource.action({
        ...call("PUT", token, { ...update, cron: "*/30 * * * *" }),
        params: { scheduleId: own.id },
      })
    )?.status
  ).toBe(200);
  expect(
    (await database.prisma.taskSchedule.findFirst({ where: { friendlyId: own.id } }))
      ?.generatorExpression
  ).toBe("*/30 * * * *");
  expect(
    (await database.prisma.taskSchedule.findFirst({ where: { id: schedule.id } }))?.active
  ).toBe(true);
  await database.prisma.taskScheduleInstance.deleteMany({
    where: { taskScheduleId: schedule.id, environmentId: sibling.id },
  });
  expect(
    (await deactivate.action(call("POST", await tokenFor(seed.environment, ["read:schedules"]))))
      .status
  ).toBe(403);
  expect((await deactivate.action(call("POST"))).status).toBe(200);
  expect((await activate.action(call("POST"))).status).toBe(200);
  expect((await resource.action(call("DELETE")))?.status).toBe(200);
  expect(await database.prisma.taskSchedule.findFirst({ where: { id: schedule.id } })).toBeNull();
}
