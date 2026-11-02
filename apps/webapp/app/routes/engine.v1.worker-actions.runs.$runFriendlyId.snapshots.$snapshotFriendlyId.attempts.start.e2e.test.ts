import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";
import type { WorkerQueueSubscription } from "@trigger.dev/core/v3/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  seedEngineFixtures,
  workerHeaders,
  type EngineFixtures,
} from "../../test/bench/lib/engineFixtures";

const LEGACY_MASTER_QUEUE = "my workers";
const subscription: WorkerQueueSubscription = {
  class: "ondemand",
  phase: "fresh",
  compat: "container",
  channel: "stable",
};

type Ctx = { server: TestServer; fixtures: EngineFixtures };

async function startServer(workerGroupId: string, check: string): Promise<Ctx> {
  const server = await startTestServer({
    extraEnv: {
      RUN_ENGINE_WORKER_QUEUE_SUBSCRIPTIONS: JSON.stringify({ [workerGroupId]: [subscription] }),
      RUN_ENGINE_DUPLICATE_ATTEMPT_START_CHECK: check,
    },
    overrideEnv: { RUN_ENGINE_WORKER_ENABLED: "1" },
  });
  const fixtures = await seedEngineFixtures(server.prisma, {
    taskCount: 1,
    workerGroupId,
    masterQueue: LEGACY_MASTER_QUEUE,
    enableFastPath: true,
  });
  return { server, fixtures };
}

function workerCall(ctx: Ctx, path: string, body: unknown = {}) {
  return ctx.server.webapp.fetch(path, {
    method: "POST",
    headers: {
      ...(workerHeaders(ctx.fixtures, "supervisor-1") as Record<string, string>),
      "x-trigger-worker-runner-id": "runner-1",
    },
    body: JSON.stringify(body),
  });
}

async function triggerAndDequeue(ctx: Ctx) {
  const res = await ctx.server.webapp.fetch(
    `/api/v1/tasks/${ctx.fixtures.taskIdentifiers[0]!}/trigger`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.fixtures.environmentApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload: {} }),
    }
  );
  expect(res.ok).toBe(true);

  for (let i = 0; i < 40; i++) {
    const dequeued = await workerCall(ctx, "/engine/v1/worker-actions/dequeue");
    const messages = (await dequeued.json()) as any[];
    if (messages.length > 0) {
      return {
        run: messages[0].run.friendlyId as string,
        snapshot: messages[0].snapshot.friendlyId as string,
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("dequeue returned nothing");
}

const runPath = (run: string, rest: string) => `/engine/v1/worker-actions/runs/${run}/${rest}`;

function start(ctx: Ctx, run: string, snapshot: string) {
  return workerCall(ctx, runPath(run, `snapshots/${snapshot}/attempts/start`));
}

describe("attempt start on a run already executing, enforced", () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await startServer("duplicate-start-enforce", "enforce");
  }, 300_000);

  afterAll(async () => {
    await ctx?.server.stop();
  }, 120_000);

  it("refuses a second start while the first attempt is executing", async () => {
    const { run, snapshot } = await triggerAndDequeue(ctx);
    const first = (await (await start(ctx, run, snapshot)).json()) as any;
    expect(first.snapshot.executionStatus).toBe("EXECUTING");

    const second = await start(ctx, run, first.snapshot.friendlyId);
    expect(second.status).toBe(409);
    const body = (await second.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["error"]);
  }, 120_000);

  it("starts the next attempt after an immediate retry", async () => {
    const { run, snapshot } = await triggerAndDequeue(ctx);
    // The fixture task allows one attempt.
    await ctx.server.prisma.taskRun.update({
      where: { friendlyId: run },
      data: { maxAttempts: 3 },
    });
    const first = (await (await start(ctx, run, snapshot)).json()) as any;

    const completed = await workerCall(
      ctx,
      runPath(run, `snapshots/${first.snapshot.friendlyId}/attempts/complete`),
      {
        completion: {
          ok: false,
          id: run,
          error: { type: "BUILT_IN_ERROR", name: "Error", message: "boom", stackTrace: "" },
          retry: { timestamp: Date.now(), delay: 0 },
        },
      }
    );
    expect(completed.status).toBe(200);
    const result = ((await completed.json()) as any).result;
    expect(result.attemptStatus).toBe("RETRY_IMMEDIATELY");

    const retried = await start(ctx, run, result.snapshot.friendlyId);
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as any).run.attemptNumber).toBe(2);
  }, 120_000);
});

describe("attempt start on a run already executing, logged", () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await startServer("duplicate-start-log", "log");
  }, 300_000);

  afterAll(async () => {
    await ctx?.server.stop();
  }, 120_000);

  it("allows a second start, as before", async () => {
    const { run, snapshot } = await triggerAndDequeue(ctx);
    const first = (await (await start(ctx, run, snapshot)).json()) as any;

    const second = await start(ctx, run, first.snapshot.friendlyId);
    expect(second.status).toBe(200);
    expect(((await second.json()) as any).run.attemptNumber).toBe(2);
  }, 120_000);
});
