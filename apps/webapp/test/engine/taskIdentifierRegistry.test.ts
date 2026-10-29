import { setTimeout } from "node:timers/promises";
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

// Polls until `count` backends in this test's database are blocked on a lock.
async function waitForLockWaiters(prisma: PrismaClient, count: number, what: string) {
  const deadline = performance.now() + 5_000;
  let waiting = 0;
  while (performance.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    waiting = row.n;
    if (waiting >= count) return;
    await setTimeout(20);
  }
  expect(waiting, `${what} never blocked on a lock`).toBeGreaterThanOrEqual(count);
}

type SyncCall = { workerId: string; tasks: string[] };

// Runs two syncs in a fixed interleaving. A separate transaction holds the row
// lock on `gateSlug`; `first` starts and blocks (directly or not) on it, then
// `second` starts and blocks, then the gate is released. Returns the error of
// each sync that failed.
async function runSyncsBehindRowGate(
  prisma: PrismaClient,
  env: AuthenticatedEnvironment,
  gateSlug: string,
  first: SyncCall,
  second: SyncCall
): Promise<string[]> {
  const sync = ({ workerId, tasks }: SyncCall) =>
    Promise.allSettled([
      syncTaskIdentifiers(
        env.id,
        env.project.id,
        workerId,
        tasks.map((id) => ({ id })),
        prisma
      ),
    ]);

  let releaseGate!: () => void;
  const gateReleased = new Promise<void>((resolve) => (releaseGate = resolve));
  let gateHeld!: () => void;
  const gateHeldPromise = new Promise<void>((resolve) => (gateHeld = resolve));
  const gate = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "TaskIdentifier"
        WHERE "runtimeEnvironmentId" = ${env.id} AND slug = ${gateSlug}
        FOR UPDATE`;
      gateHeld();
      await gateReleased;
    },
    // Shorter than the test timeout, so a hung test still closes the gate.
    { timeout: 15_000 }
  );

  let firstResult: ReturnType<typeof sync> | undefined;
  let secondResult: ReturnType<typeof sync> | undefined;
  try {
    await Promise.race([gateHeldPromise, gate]);

    firstResult = sync(first);
    await waitForLockWaiters(prisma, 1, "first sync");

    secondResult = sync(second);
    await waitForLockWaiters(prisma, 2, "second sync");

    releaseGate();
    await gate;

    const results = (await Promise.all([firstResult, secondResult])).flat();
    return results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
  } finally {
    releaseGate();
    await gate.catch(() => {});
    // Don't leave a sync running into fixture teardown if a wait above failed.
    await Promise.all([firstResult, secondResult]);
  }
}

async function seedSyncedTasks(
  prisma: PrismaClient,
  env: AuthenticatedEnvironment,
  slugs: string[]
) {
  const worker = await createWorker(prisma, env);
  await syncTaskIdentifiers(
    env.id,
    env.project.id,
    worker.id,
    slugs.map((id) => ({ id })),
    prisma
  );
}

async function taskIdentifierState(prisma: PrismaClient, env: AuthenticatedEnvironment) {
  const rows = await prisma.taskIdentifier.findMany({
    where: { runtimeEnvironmentId: env.id },
    orderBy: { slug: "asc" },
  });
  return rows.map((r) => [r.slug, r.isInLatestDeployment, r.currentWorkerId]);
}

async function createWorker(prisma: PrismaClient, env: AuthenticatedEnvironment) {
  return prisma.backgroundWorker.create({
    data: {
      friendlyId: generateFriendlyId("worker"),
      contentHash: `hash-${Date.now()}-${Math.random()}`,
      projectId: env.project.id,
      runtimeEnvironmentId: env.id,
      version: `${Date.now()}-${Math.random()}`,
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

  // Two dev sessions (or a promote racing a rollback) sync the same environment
  // with different task lists. Each sync updates its own tasks and then archives
  // everything else, so each can hold rows the other's next statement needs.
  postgresTest(
    "should not deadlock when concurrent syncs update and archive each other's tasks",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "DEVELOPMENT");
      await seedSyncedTasks(prisma, env, ["task-a", "task-b", "task-c"]);
      const firstWorker = await createWorker(prisma, env);
      const secondWorker = await createWorker(prisma, env);

      // The first sync locks a and waits on c. The second locks b and queues
      // behind the first for c. When the gate opens, the first takes c and its
      // archive then needs b, held by the second.
      const failures = await runSyncsBehindRowGate(
        prisma,
        env,
        "task-c",
        { workerId: firstWorker.id, tasks: ["task-a", "task-c"] },
        { workerId: secondWorker.id, tasks: ["task-b", "task-c"] }
      );

      expect(failures, failures.join("\n")).toEqual([]);
      // The first sync commits, then the second runs, so its task list wins.
      expect(await taskIdentifierState(prisma, env)).toEqual([
        ["task-a", false, firstWorker.id],
        ["task-b", true, secondWorker.id],
        ["task-c", true, secondWorker.id],
      ]);
    }
  );

  postgresTest(
    "should not deadlock when a sync's archive step waits on a concurrent sync",
    async ({ prisma }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "DEVELOPMENT");
      await seedSyncedTasks(prisma, env, ["task-a", "task-b", "task-c"]);
      const firstWorker = await createWorker(prisma, env);
      const secondWorker = await createWorker(prisma, env);

      // The first sync locks a and waits on b. The second locks c, then its
      // archive waits on a. When the gate opens, the first takes b and then
      // needs c, held by the second.
      const failures = await runSyncsBehindRowGate(
        prisma,
        env,
        "task-b",
        { workerId: firstWorker.id, tasks: ["task-a", "task-b", "task-c"] },
        { workerId: secondWorker.id, tasks: ["task-c"] }
      );

      expect(failures, failures.join("\n")).toEqual([]);
      expect(await taskIdentifierState(prisma, env)).toEqual([
        ["task-a", false, firstWorker.id],
        ["task-b", false, firstWorker.id],
        ["task-c", true, secondWorker.id],
      ]);
    }
  );
});
