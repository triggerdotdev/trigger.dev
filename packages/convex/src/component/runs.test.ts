import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { defineTestApp, type ComponentRegistration } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { Trigger, vRun, type ComponentApi } from "../client/index.js";
import schema from "./schema.js";
import { MAX_INLINE_BYTES, MIN_REFRESH_INTERVAL_MS } from "./shared.js";

const modules = {
  "./_generated/component.ts": () => import("./_generated/component.js"),
  "./runs.ts": () => import("./runs.js"),
  "./worker.ts": () => import("./worker.js"),
};
const app = defineTestApp({
  schema: defineSchema({
    completions: defineTable({ run: vRun }),
    controls: defineTable({ failCallback: v.boolean() }),
  }),
  components: {
    trigger: {
      register: ((t, name) =>
        t.registerComponent(name, schema, modules)) as ComponentRegistration<ComponentApi>,
    },
  },
});
let baseUrl: string;
const { createTest, api, internal } = app.defineModules({
  callbacks: {
    complete: app.internalMutation({
      args: { run: vRun },
      handler: async (ctx, args) => {
        if ((await ctx.db.query("controls").first())?.failCallback)
          throw new Error("Callback unavailable");
        await ctx.db.insert("completions", args);
      },
    }),
  },
  jobs: {
    request: app.mutation({
      args: {
        rollback: v.optional(v.boolean()),
        key: v.optional(v.string()),
        payload: v.optional(v.any()),
      },
      handler: async (ctx, args): Promise<string> => {
        const trigger = new Trigger(app.components.trigger, {
          secretKey: "test-only-key",
          baseUrl,
          onComplete: internal.callbacks.complete,
        });
        const id = await trigger.trigger(
          ctx,
          "render-video",
          args.payload ?? { videoId: "video-1" },
          {
            idempotencyKey: args.key,
            tags: ["video:1"],
          }
        );
        if (args.rollback) throw new Error("Roll back the application transaction");
        return id;
      },
    }),
    refresh: app.mutation({
      args: { id: v.string() },
      handler: async (ctx, { id }) => new Trigger(app.components.trigger).refresh(ctx, id),
    }),
  },
});

async function drain(t: ReturnType<typeof createTest>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    vi.advanceTimersToNextTimer();
    await t.finishInProgressScheduledFunctions();
    const { page } = await t.query(app.components.trigger.runs.list, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    if (page.every((run) => run.syncStatus === "complete" || run.syncStatus === "paused")) return;
  }
  throw new Error("Runs did not settle");
}

let server: Server;
let submissions: number;
let polls: number;
let remoteRuns: Map<string, string>;
let loseFirstResponse: boolean;
let triggerStatus: number;
let pollFailures: number;
let pollFailureStatus: number;
let pollRetryHeader: string | undefined;
let activePolls: number;
let remoteStatus: string;
let remoteIsCompleted: boolean;
let largeOutput: boolean;
let submittedOptions: Record<string, unknown>;
let holdNextPoll: boolean;
let releasePoll: (() => void) | undefined;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer test-only-key") {
      res.writeHead(401).end("{}");
      return;
    }
    if (req.method === "POST") {
      submissions++;
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      submittedOptions = data.options;
      if (triggerStatus !== 200) {
        res.writeHead(triggerStatus).end("{}");
        return;
      }
      const key: string = data.options.idempotencyKey;
      if (!remoteRuns.has(key)) remoteRuns.set(key, `run_${remoteRuns.size + 1}`);
      if (loseFirstResponse && submissions === 1) {
        res.destroy();
        return;
      }
      res.end(JSON.stringify({ id: remoteRuns.get(key) }));
    } else {
      polls++;
      if (pollFailures-- > 0) {
        if (pollRetryHeader !== undefined) res.setHeader("x-should-retry", pollRetryHeader);
        res.writeHead(pollFailureStatus).end("{}");
        return;
      }
      const completed = activePolls-- <= 0;
      const body = JSON.stringify({
        id: "run_1",
        status: completed ? remoteStatus : "EXECUTING",
        isCompleted: completed && remoteIsCompleted,
        output: completed
          ? largeOutput
            ? "x".repeat(MAX_INLINE_BYTES + 1)
            : { url: "https://example.com/video.mp4" }
          : undefined,
        metadata: { progress: completed ? 100 : 50 },
      });
      if (holdNextPoll) {
        holdNextPoll = false;
        releasePoll = () => {
          if (!res.writableEnded) res.end(body);
          releasePoll = undefined;
        };
      } else {
        res.end(body);
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  submissions = 0;
  polls = 0;
  remoteRuns = new Map();
  loseFirstResponse = false;
  triggerStatus = 200;
  pollFailures = 0;
  pollFailureStatus = 503;
  pollRetryHeader = undefined;
  activePolls = 0;
  remoteStatus = "COMPLETED";
  remoteIsCompleted = true;
  largeOutput = false;
  submittedOptions = {};
  holdNextPoll = false;
  releasePoll = undefined;
});
afterEach(() => {
  releasePoll?.();
  vi.useRealTimers();
});
afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    })
);

test("rolling back the application mutation never submits work", async () => {
  const t = createTest();
  await expect(t.mutation(api.jobs.request, { rollback: true })).rejects.toThrow("Roll back");
  await drain(t);
  expect(submissions).toBe(0);
  expect(
    await t.query(app.components.trigger.runs.list, {
      paginationOpts: { numItems: 10, cursor: null },
    })
  ).toMatchObject({ page: [] });
});

test("deduplicates requests, stores reactive results, and calls the app once without exposing credentials", async () => {
  const t = createTest();
  const id = await t.mutation(api.jobs.request, { key: "render:1" });
  expect(await t.mutation(api.jobs.request, { key: "render:1" })).toBe(id);
  await drain(t);
  await drain(t);
  const run = await t.query(app.components.trigger.runs.get, { id });
  expect(run).toMatchObject({
    runId: "run_1",
    status: "COMPLETED",
    syncStatus: "complete",
    output: { url: "https://example.com/video.mp4" },
    metadata: { progress: 100 },
  });
  expect(JSON.stringify(run)).not.toContain("test-only-key");
  expect(
    JSON.stringify(
      await t.query(app.components.trigger.runs.list, {
        paginationOpts: { numItems: 10, cursor: null },
      })
    )
  ).not.toContain("test-only-key");
  expect(submissions).toBe(1);
  expect(submittedOptions).toMatchObject({ tags: ["video:1"], idempotencyKeyTTL: "24h" });
  expect(await t.run((ctx) => ctx.db.query("completions").collect())).toHaveLength(1);
});

test("retries an ambiguous submission using the same remote idempotency key", async () => {
  loseFirstResponse = true;
  const t = createTest();
  const id = await t.mutation(api.jobs.request, {});
  await drain(t);
  expect(submissions).toBe(2);
  expect(remoteRuns.size).toBe(1);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    syncStatus: "complete",
  });
});

test("recovers from temporary polling failures and observes cancellation without task hooks", async () => {
  pollFailures = 2;
  remoteStatus = "CANCELED";
  const t = createTest();
  const id = await t.mutation(api.jobs.request, {});
  await drain(t);
  expect(polls).toBe(3);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    status: "CANCELED",
    syncStatus: "complete",
  });
});

test.each(["EXPIRED", "TIMED_OUT"])(
  "finishes %s runs even when isCompleted is false",
  async (status) => {
    remoteStatus = status;
    remoteIsCompleted = false;
    const t = createTest();
    const id = await t.mutation(api.jobs.request, {});
    await drain(t);
    await drain(t);
    expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
      status,
      syncStatus: "complete",
    });
    expect(polls).toBe(1);
    const completions = await t.run((ctx) => ctx.db.query("completions").collect());
    expect(completions).toHaveLength(1);
    expect(completions[0]?.run.status).toBe(status);
  }
);

test.each([
  { status: 404, header: "true", syncStatus: "complete", expectedPolls: 2 },
  { status: 404, header: undefined, syncStatus: "paused", expectedPolls: 1 },
  { status: 503, header: "false", syncStatus: "paused", expectedPolls: 1 },
])(
  "honors retry policy for HTTP $status with x-should-retry=$header",
  async ({ status, header, syncStatus, expectedPolls }) => {
    pollFailures = 1;
    pollFailureStatus = status;
    pollRetryHeader = header;
    const t = createTest();
    const id = await t.mutation(api.jobs.request, {});
    await drain(t);
    expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({ syncStatus });
    expect(polls).toBe(expectedPolls);
  }
);

test("pauses a rejected submission and can resume it inside the retry window", async () => {
  triggerStatus = 401;
  const t = createTest();
  const id = await t.mutation(api.jobs.request, {});
  await drain(t);
  expect(submissions).toBe(1);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    syncStatus: "paused",
  });
  triggerStatus = 200;
  await t.mutation(app.components.trigger.runs.resume, {
    id,
    config: { baseUrl, secretKey: "test-only-key" },
  });
  await drain(t);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    syncStatus: "complete",
  });
});

test("keeps completion usable when the remote output exceeds the document budget", async () => {
  largeOutput = true;
  const t = createTest();
  const id = await t.mutation(api.jobs.request, {});
  await drain(t);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    syncStatus: "complete",
    outputOmitted: true,
  });
});

test("tracks active work without invoking completion early", async () => {
  activePolls = 1;
  const t = createTest();
  const id = await t.mutation(api.jobs.request, {});
  for (let i = 0; i < 20 && polls === 0; i++) {
    vi.advanceTimersToNextTimer();
    await t.finishInProgressScheduledFunctions();
  }
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    status: "EXECUTING",
    syncStatus: "active",
    metadata: { progress: 50 },
  });
  expect(await t.run((ctx) => ctx.db.query("completions").collect())).toHaveLength(0);
  await drain(t);
  expect(await t.run((ctx) => ctx.db.query("completions").collect())).toHaveLength(1);
});

test("a failing callback rolls back completion and can be retried without duplicate application writes", async () => {
  const t = createTest();
  const controlId = await t.run((ctx) => ctx.db.insert("controls", { failCallback: true }));
  const id = await t.mutation(api.jobs.request, {});
  await drain(t);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    syncStatus: "paused",
  });
  expect(await t.run((ctx) => ctx.db.query("completions").collect())).toHaveLength(0);
  await t.run((ctx) => ctx.db.patch(controlId, { failCallback: false }));
  await t.mutation(app.components.trigger.runs.resume, {
    id,
    config: { secretKey: "test-only-key", baseUrl },
  });
  await drain(t);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    syncStatus: "complete",
  });
  expect(await t.run((ctx) => ctx.db.query("completions").collect())).toHaveLength(1);
});

async function runScheduled(t: ReturnType<typeof createTest>, advanceMs = 0): Promise<void> {
  // Convex timestamps have sub-millisecond precision, so zero-delay jobs may fall just after now.
  vi.advanceTimersByTime(advanceMs + 1);
  await t.finishInProgressScheduledFunctions();
  vi.advanceTimersByTime(1);
  await t.finishInProgressScheduledFunctions();
}

// Catches: refresh bursts bypassing the check cooldown or racing the polling callback.
test("refreshes promptly, bounds repeated checks, and completes once alongside polling", async () => {
  activePolls = 1;
  const t = createTest();
  const id = await t.mutation(api.jobs.request, {});
  await runScheduled(t);
  expect(submissions).toBe(1);
  expect(polls).toBe(0);

  await Promise.all(Array.from({ length: 3 }, () => t.mutation(api.jobs.refresh, { id })));
  await runScheduled(t);
  expect(polls).toBe(1);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    status: "EXECUTING",
    metadata: { progress: 50 },
  });

  await Promise.all(Array.from({ length: 3 }, () => t.mutation(api.jobs.refresh, { id })));
  await runScheduled(t, MIN_REFRESH_INTERVAL_MS / 2);
  expect(polls).toBe(1);
  await runScheduled(t, MIN_REFRESH_INTERVAL_MS / 2);
  expect(polls).toBe(2);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    status: "COMPLETED",
    syncStatus: "complete",
    output: { url: "https://example.com/video.mp4" },
  });
  await t.mutation(api.jobs.refresh, { id });
  await drain(t);
  expect(polls).toBe(2);
  expect(submissions).toBe(1);
  expect(await t.run((ctx) => ctx.db.query("completions").collect())).toHaveLength(1);
});

// Catches: refresh fencing out an in-flight observation or losing its completion hint.
test("coalesces hints during an in-flight request and follows it with another check", async () => {
  activePolls = 1;
  const t = createTest();
  const id = await t.mutation(api.jobs.request, {});
  await runScheduled(t);
  holdNextPoll = true;
  const received = once(server, "request");
  await t.mutation(api.jobs.refresh, { id });
  vi.advanceTimersByTime(1);
  await t.finishInProgressScheduledFunctions();
  vi.advanceTimersByTime(1);
  const checking = t.finishInProgressScheduledFunctions();
  await received;
  try {
    await t.mutation(api.jobs.refresh, { id });
    await t.mutation(api.jobs.refresh, { id });
    vi.advanceTimersByTime(MIN_REFRESH_INTERVAL_MS);
    expect(polls).toBe(1);
    releasePoll!();
    await checking;
    expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
      status: "EXECUTING",
      syncStatus: "active",
      metadata: { progress: 50 },
    });
    await runScheduled(t);
    expect(polls).toBe(2);
    expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
      status: "COMPLETED",
      syncStatus: "complete",
    });
    expect(await t.run((ctx) => ctx.db.query("completions").collect())).toHaveLength(1);
  } finally {
    releasePoll?.();
    await checking;
  }
});

// Catches: a failed status request leaving refresh permanently blocked as in-flight.
test("allows a refresh after a retryable status error", async () => {
  pollFailures = 1;
  const t = createTest();
  const id = await t.mutation(api.jobs.request, {});
  await runScheduled(t);
  await t.mutation(api.jobs.refresh, { id });
  await runScheduled(t);
  expect(polls).toBe(1);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    syncStatus: "active",
  });
  await t.mutation(api.jobs.refresh, { id });
  await runScheduled(t, MIN_REFRESH_INTERVAL_MS);
  expect(polls).toBe(2);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    syncStatus: "complete",
  });
});

// Catches: browser hints resubmitting pending work or bypassing a permanent synchronization failure.
test("does not submit pending work early or resume paused synchronization", async () => {
  pollFailures = 1;
  pollFailureStatus = 401;
  const t = createTest();
  const id = await t.mutation(api.jobs.request, {});
  await t.mutation(api.jobs.refresh, { id });
  expect(submissions).toBe(0);
  await runScheduled(t);
  await t.mutation(api.jobs.refresh, { id });
  await runScheduled(t);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    syncStatus: "paused",
  });
  await t.mutation(api.jobs.refresh, { id });
  await runScheduled(t, MIN_REFRESH_INTERVAL_MS);
  expect(polls).toBe(1);
  expect(submissions).toBe(1);
  await t.mutation(app.components.trigger.runs.resume, {
    id,
    config: { secretKey: "test-only-key", baseUrl },
  });
  await drain(t);
  expect(await t.query(app.components.trigger.runs.get, { id })).toMatchObject({
    syncStatus: "complete",
  });
});

test("rejects large inputs before scheduling remote work", async () => {
  const t = createTest();
  await expect(
    t.mutation(api.jobs.request, { payload: "x".repeat(MAX_INLINE_BYTES + 1) })
  ).rejects.toThrow("256 KiB");
  await drain(t);
  expect(submissions).toBe(0);
});
