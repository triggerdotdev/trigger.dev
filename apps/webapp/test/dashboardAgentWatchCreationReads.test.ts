import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";

// The replica lags: it has neither the just-triggered run nor the just-created queue.
const ctx = vi.hoisted(() => ({
  primaryReads: [] as string[],
  replicaReads: [] as string[],
}));

vi.mock("~/db.server", () => ({
  prisma: {
    taskQueue: {
      findFirst: async () => {
        ctx.primaryReads.push("queue");
        return { id: "queue_1" };
      },
    },
  },
  $replica: {
    taskQueue: {
      findFirst: async () => {
        ctx.replicaReads.push("queue");
        return null;
      },
    },
  },
  sqlDatabaseSchema: undefined,
}));

vi.mock("~/v3/runStore.server", () => ({
  runStore: {
    findRunOnPrimary: async () => {
      ctx.primaryReads.push("run");
      return { friendlyId: "run_1", status: "PENDING" };
    },
    findRun: async () => {
      ctx.replicaReads.push("run");
      return null;
    },
  },
}));

const { watchCheckDeps, watchCreationCheckDeps } =
  await import("~/services/dashboardAgentWatchChecks.server");

const environment = { id: "env_1" } as AuthenticatedEnvironment;

beforeEach(() => {
  ctx.primaryReads = [];
  ctx.replicaReads = [];
});

describe("the watch target reads", () => {
  test("creation reads the run and the queue on the primary", async () => {
    const deps = watchCreationCheckDeps(environment);

    expect(await deps.readRun("run_1")).not.toBeNull();
    expect(await deps.queueExists("task/my-task")).toBe(true);
    expect(ctx.primaryReads).toEqual(["run", "queue"]);
    expect(ctx.replicaReads).toEqual([]);
  });

  test("polling keeps both reads on the replica", async () => {
    const deps = watchCheckDeps(environment);

    expect(await deps.readRun("run_1")).toBeNull();
    expect(await deps.queueExists("task/my-task")).toBe(false);
    expect(ctx.replicaReads).toEqual(["run", "queue"]);
    expect(ctx.primaryReads).toEqual([]);
  });
});
