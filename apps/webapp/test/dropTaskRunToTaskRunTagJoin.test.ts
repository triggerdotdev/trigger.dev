// Single-version proof for dropping the dead `_TaskRunToTaskRunTag` implicit join.

import { describe, expect } from "vitest";
import { postgresTest } from "@internal/testcontainers";

describe("drop _TaskRunToTaskRunTag implicit join", () => {
  // 120s timeout: this test had no override and ran on vitest's 5s default,
  // which flaked whenever cold Postgres testcontainer startup on a loaded CI
  // runner pushed the first query past 5s.
  postgresTest(
    "runTags scalar round-trips and the join table is gone",
    async ({ prisma }) => {
      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test",
          slug: "test",
          organizationId: organization.id,
          externalRef: "test",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test",
          pkApiKey: "test",
          shortcode: "test",
        },
      });

      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          payloadType: "application/json",
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          runTags: ["alpha", "beta"],
        },
      });

      const readBack = await prisma.taskRun.findFirstOrThrow({
        where: { id: taskRun.id },
      });
      expect(readBack.runTags).toEqual(["alpha", "beta"]);

      const result = await prisma.$queryRaw<{ t: string | null }[]>`
      SELECT to_regclass('public._TaskRunToTaskRunTag')::text as t
    `;
      expect(result[0].t).toBeNull();
    },
    120_000
  );
});
