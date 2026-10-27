import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { getTraceAncestorInsertedAtStart } from "~/v3/eventRepository/traceAncestorBound.server";
import { buildRunStore } from "~/v3/runStore.server";

vi.setConfig({ testTimeout: 60_000 });

const ENV_ID = "env_trace_ancestor_bound";
// A v1 body (version "1" at index 25) resolves to the new run-ops store.
const ROOT_ID = "r".repeat(24) + "01";
const MISSING_ROOT_ID = "m".repeat(24) + "01";
const ROOT_CREATED_AT = new Date("2026-10-20T10:00:00.000Z");
const CHILD_CREATED_AT = new Date("2026-10-20T10:05:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function createRootRun(prisma: PrismaClient) {
  await prisma.taskRun.create({
    data: {
      id: ROOT_ID,
      engine: "V2",
      status: "EXECUTING",
      friendlyId: `run_${ROOT_ID}`,
      runtimeEnvironmentId: ENV_ID,
      environmentType: "DEVELOPMENT",
      organizationId: "org_trace_ancestor_bound",
      projectId: "proj_trace_ancestor_bound",
      taskIdentifier: "root-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: "trace_ancestor_bound",
      spanId: "span_root",
      queue: "task/root-task",
      createdAt: ROOT_CREATED_AT,
    },
  });
}

describe("getTraceAncestorInsertedAtStart", () => {
  heteroRunOpsPostgresTest(
    "starts a day before the root run's createdAt, or the run's own when it has no root",
    async ({ prisma14, prisma17 }) => {
      await createRootRun(prisma17);
      const store = buildRunStore({
        splitEnabled: true,
        newWriter: prisma17,
        newReplica: prisma17,
        legacyWriter: prisma14,
        legacyReplica: prisma14,
        singleWriter: prisma14,
        singleReplica: prisma14,
      });
      const child = {
        friendlyId: "run_child",
        createdAt: CHILD_CREATED_AT,
        runtimeEnvironmentId: ENV_ID,
      };

      // Root on the run-ops store, read through the control-plane replica client.
      expect(
        await getTraceAncestorInsertedAtStart({ ...child, rootTaskRunId: ROOT_ID }, store, prisma14)
      ).toEqual(new Date(ROOT_CREATED_AT.getTime() - DAY_MS));

      expect(
        await getTraceAncestorInsertedAtStart({ ...child, rootTaskRunId: null }, store, prisma14)
      ).toEqual(new Date(CHILD_CREATED_AT.getTime() - DAY_MS));

      expect(
        await getTraceAncestorInsertedAtStart(
          { ...child, rootTaskRunId: MISSING_ROOT_ID },
          store,
          prisma14
        )
      ).toBeUndefined();

      // Another environment's root isn't used.
      expect(
        await getTraceAncestorInsertedAtStart(
          { ...child, rootTaskRunId: ROOT_ID, runtimeEnvironmentId: "env_other" },
          store,
          prisma14
        )
      ).toBeUndefined();
    }
  );
});
