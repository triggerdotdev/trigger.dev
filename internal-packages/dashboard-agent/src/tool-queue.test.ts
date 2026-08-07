import { describe, expect, it } from "vitest";
import { consumerTasksForQueue, queueMetricsAreEmpty } from "./tool-api";

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
