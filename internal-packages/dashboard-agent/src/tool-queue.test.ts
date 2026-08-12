import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildApiTools,
  consumerTasksForQueue,
  pickQueueLiveState,
  queueMetricsAreEmpty,
  queueNameForKind,
  readQueueLiveState,
  withLiveState,
} from "./tool-api";
import { createApiClient } from "./tool-api-client";

/**
 * The metrics route answers an unknown queue with zeroes rather than a 404, so asking for
 * the wrong queue kind reads exactly like an idle queue. `get_queue` retries with the other
 * kind before believing that, which is what stops "no queue named email-sends exists" being
 * said about a queue holding thousands of runs.
 */
describe("queueMetricsAreEmpty", () => {
  const zeroes = {
    peakQueued: 0,
    startedCount: 0,
    throttledCount: 0,
    depthTrend: [],
    waitMs: { p50: null, p95: null },
  };

  it("treats an all-zero answer as no evidence the queue exists", () => {
    expect(queueMetricsAreEmpty(zeroes)).toBe(true);
    expect(queueMetricsAreEmpty(null)).toBe(true);
  });

  it("takes any single sign of life as evidence", () => {
    expect(queueMetricsAreEmpty({ ...zeroes, peakQueued: 4800 })).toBe(false);
    expect(queueMetricsAreEmpty({ ...zeroes, startedCount: 3 })).toBe(false);
    expect(queueMetricsAreEmpty({ ...zeroes, throttledCount: 1 })).toBe(false);
    expect(queueMetricsAreEmpty({ ...zeroes, depthTrend: [0, 0] })).toBe(false);
    expect(queueMetricsAreEmpty({ ...zeroes, waitMs: { p50: 0, p95: null } })).toBe(false);
  });
});

/**
 * The environment that produced the bug: `email-sends` is a custom queue two deployed tasks
 * write to, and no task is named after it. Reading the deployed task list for a task called
 * `email-sends` finds nothing, which is what let the agent invent a deleted task.
 */
describe("consumerTasksForQueue", () => {
  const workers = {
    worker: {
      tasks: [
        { slug: "send-order-receipt", queueConfig: { name: "email-sends" } },
        { slug: "send-welcome-email", queueConfig: { name: "email-sends" } },
        { slug: "generate-monthly-report", queueConfig: { name: "reports-heavy" } },
        { slug: "sync-inventory", queueConfig: { name: "webhooks" } },
        { slug: "email-sends-audit", queueConfig: null },
      ],
    },
  };

  it("names the tasks that write to a custom queue nothing is named after", () => {
    expect(consumerTasksForQueue(workers, "email-sends")).toEqual([
      "send-order-receipt",
      "send-welcome-email",
    ]);
    expect(consumerTasksForQueue(workers, "reports-heavy")).toEqual(["generate-monthly-report"]);
  });

  it("matches the queue config's name, not the task slug", () => {
    // `email-sends-audit` has no queue config, so it is on its own task queue.
    expect(consumerTasksForQueue(workers, "email-sends-audit")).toEqual([]);
    expect(consumerTasksForQueue(workers, "send-order-receipt")).toEqual([]);
  });

  it("says nothing rather than something wrong when the task list is missing", () => {
    expect(consumerTasksForQueue(null, "email-sends")).toEqual([]);
    expect(consumerTasksForQueue({ worker: {} }, "email-sends")).toEqual([]);
    expect(consumerTasksForQueue({ worker: { tasks: [{}] } }, "email-sends")).toEqual([]);
  });
});

/**
 * A queue nobody can read is not a queue that isn't there. Only the route answering 404 is
 * evidence of absence; a 401, a 429 or a 5xx is evidence of nothing, and reporting one as
 * `exists: false` tells the model a queue holding thousands of runs was deleted.
 */
describe("the queue's live row has three answers, not two", () => {
  const metrics = { peakQueued: 4800, startedCount: 12 };

  it("reads a row, a 404 and a failed read apart", () => {
    expect(readQueueLiveState({ ok: true, data: { paused: true } })).toEqual({
      kind: "row",
      row: { paused: true },
    });
    expect(readQueueLiveState({ ok: false, status: 404 })).toEqual({ kind: "missing" });
    for (const status of [401, 403, 429, 500, 503]) {
      expect(readQueueLiveState({ ok: false, status })).toEqual({ kind: "unknown", status });
    }
    // No current environment: nothing was asked, so nothing is known.
    expect(readQueueLiveState(null)).toEqual({ kind: "unknown" });
  });

  it("says unknown rather than absent when the read failed", () => {
    expect(withLiveState(metrics, "custom", { kind: "unknown", status: 503 })).toMatchObject({
      exists: "unknown",
      liveStateError: "Couldn't read the queue's live row (status 503).",
    });
    expect(withLiveState(metrics, "custom", { kind: "missing" })).toMatchObject({ exists: false });
    expect(
      withLiveState(metrics, "custom", { kind: "row", row: { paused: true, queued: 9 } })
    ).toMatchObject({ exists: true, paused: true, queuedNow: 9 });
  });

  it("prefers a row, then a failed read, over a single 404", () => {
    const row = { kind: "row", row: { paused: false } } as const;
    const missing = { kind: "missing" } as const;
    const unknown = { kind: "unknown", status: 500 } as const;

    expect(pickQueueLiveState(missing, row)).toEqual(row);
    expect(pickQueueLiveState(unknown, row)).toEqual(row);
    // One kind 404s while the other read broke: that is not proof the name is free.
    expect(pickQueueLiveState(missing, unknown)).toEqual(unknown);
    expect(pickQueueLiveState(unknown, missing)).toEqual(unknown);
    expect(pickQueueLiveState(missing, missing)).toEqual(missing);
  });
});

/**
 * A queue the dashboard shows as `task/worker-1` is stored as `worker-1` when it is a custom
 * queue, so asking for it under the spelling the user copied has to lose the prefix.
 */
describe("queueNameForKind", () => {
  it("strips the task/ prefix for a custom queue only", () => {
    expect(queueNameForKind("task/worker-1", "custom")).toBe("worker-1");
    expect(queueNameForKind("task/worker-1", "task")).toBe("task/worker-1");
    expect(queueNameForKind("email-sends", "custom")).toBe("email-sends");
  });

  it("only strips a leading prefix", () => {
    expect(queueNameForKind("billing/task/retries", "custom")).toBe("billing/task/retries");
  });
});

describe("get_queue asks for a custom queue under its stored name", () => {
  const ORIGIN = "https://api.example.com";
  const WORKERS = {
    worker: { tasks: [{ slug: "process-order", queueConfig: { name: "worker-1" } }] },
  };

  function stubFetch(urls: string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/jwt")) {
          return new Response(JSON.stringify({ token: "env-jwt" }), { status: 200 });
        }
        urls.push(url);
        if (url.includes("/workers/current")) {
          return new Response(JSON.stringify(WORKERS), { status: 200 });
        }
        if (url.includes("/metrics")) {
          return new Response(JSON.stringify({ peakQueued: 12, startedCount: 4 }), { status: 200 });
        }
        return new Response(JSON.stringify({ type: "custom", paused: false, queued: 3 }), {
          status: 200,
        });
      })
    );
  }

  function getQueue() {
    const ctx = {
      userActorToken: "uat",
      apiOrigin: ORIGIN,
      projectRef: "proj_ref",
      environmentName: "dev",
    };
    const tools = buildApiTools({
      ctx,
      client: createApiClient(ctx),
      renderInvestigations: (() => []) as any,
    });
    return (input: any) => (tools.get_queue as any).execute(input, {} as any);
  }

  afterEach(() => vi.unstubAllGlobals());

  it("drops the task/ prefix from the metrics, live and consumer reads", async () => {
    const urls: string[] = [];
    stubFetch(urls);

    const answer = await getQueue()({ queue: "task/worker-1", type: "custom" });

    expect(urls.some((url) => url.includes("/api/v1/queues/worker-1/metrics?type=custom"))).toBe(
      true
    );
    expect(urls.some((url) => url.includes("/api/v1/queues/worker-1?type=custom"))).toBe(true);
    expect(urls.some((url) => url.includes("task%2Fworker-1"))).toBe(false);
    expect(answer).toMatchObject({ exists: true, consumerTasks: ["process-order"] });
  });

  it("leaves a task queue's own name alone", async () => {
    const urls: string[] = [];
    stubFetch(urls);

    await getQueue()({ queue: "task/worker-1", type: "task" });

    expect(
      urls.some((url) => url.includes("/api/v1/queues/task%2Fworker-1/metrics?type=task"))
    ).toBe(true);
  });
});

/** The same three cases through `get_queue`, since the tool output is what the model reads. */
describe("get_queue reports the live read it actually got", () => {
  const ORIGIN = "https://api.example.com";

  function stubFetch(liveResponse: () => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/jwt")) {
          return new Response(JSON.stringify({ token: "env-jwt" }), { status: 200 });
        }
        if (url.includes("/metrics")) {
          return new Response(JSON.stringify({ peakQueued: 4800, startedCount: 12 }), {
            status: 200,
          });
        }
        return liveResponse();
      })
    );
  }

  function getQueue() {
    const ctx = {
      userActorToken: "uat",
      apiOrigin: ORIGIN,
      projectRef: "proj_ref",
      environmentName: "dev",
    };
    const tools = buildApiTools({
      ctx,
      client: createApiClient(ctx),
      renderInvestigations: (() => []) as any,
    });
    return (input: any) => (tools.get_queue as any).execute(input, {} as any);
  }

  afterEach(() => vi.unstubAllGlobals());

  it("reports a healthy row as the queue that exists", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ type: "custom", paused: true, queued: 31 }), { status: 200 })
    );
    await expect(getQueue()({ queue: "email-sends", type: "custom" })).resolves.toMatchObject({
      exists: true,
      paused: true,
      queuedNow: 31,
    });
  });

  it("reports a 404 as the queue that isn't there", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    await expect(getQueue()({ queue: "email-sends", type: "custom" })).resolves.toMatchObject({
      exists: false,
    });
  });

  it("reports a failed read as unknown, never as absent", async () => {
    stubFetch(() => new Response("", { status: 503 }));
    const answer = await getQueue()({ queue: "email-sends", type: "custom" });
    expect(answer).toMatchObject({ exists: "unknown" });
    expect(answer.exists).not.toBe(false);
    expect(answer.liveStateError).toContain("503");
  });
});
