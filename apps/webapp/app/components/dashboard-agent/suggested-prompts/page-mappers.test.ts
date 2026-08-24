import { agentPageContextSchema } from "@internal/dashboard-agent-contracts";
import { describe, expect, it } from "vitest";
import {
  agentsAgentPageContext,
  alertsAgentPageContext,
  batchAgentPageContext,
  batchesAgentPageContext,
  branchesAgentPageContext,
  bulkActionsAgentPageContext,
  dashboardsAgentPageContext,
  deploymentAgentPageContext,
  deploymentsAgentPageContext,
  errorAgentPageContext,
  errorsAgentPageContext,
  FRESH_FAILURE_WINDOW_MS,
  limitsAgentPageContext,
  modelsAgentPageContext,
  playgroundAgentPageContext,
  promptsAgentPageContext,
  QUEUE_OLDEST_WAIT_WARNING_MS,
  queueAgentPageContext,
  queuesAgentPageContext,
  runAgentPageContext,
  scheduleAgentPageContext,
  sectionAgentPageContext,
  sessionsAgentPageContext,
  taskAgentPageContext,
  testAgentPageContext,
  waitpointsAgentPageContext,
  type SectionPageKind,
} from "./page-mappers";

const NOW = Date.parse("2026-07-27T10:25:41.000Z");

// Arrives on the route match as JSON, so dates are ISO strings.
function runLoaderData(
  overrides: {
    status?: string;
    completedAt?: string | null;
    friendlyId?: string;
    taskId?: string;
    events?: unknown[];
  } = {}
) {
  const friendlyId = overrides.friendlyId ?? "run_abc123";
  return {
    run: {
      friendlyId,
      status: overrides.status ?? "EXECUTING",
      completedAt: overrides.completedAt ?? null,
      startedAt: "2026-07-27T10:10:00.000Z",
      isFinished: false,
      environment: { id: "env_1", organizationId: "org_1" },
    },
    trace: {
      events:
        overrides.events ??
        ([
          {
            id: "span_1",
            runId: friendlyId,
            data: { message: overrides.taskId ?? "process-order" },
          },
        ] as unknown[]),
    },
    runsList: null,
  };
}

describe("runAgentPageContext", () => {
  it("classifies the page and names the run, its status and its task", () => {
    const context = runAgentPageContext(runLoaderData(), NOW);

    expect(context).toMatchObject({
      page: {
        kind: "run",
        runId: "run_abc123",
        status: "Executing",
        taskId: "process-order",
      },
      signals: [],
    });
    expect(agentPageContextSchema.safeParse(context).success).toBe(true);
  });

  it("emits fresh_failure for a run that just failed", () => {
    const completedAt = new Date(NOW - 5 * 60_000).toISOString();
    const context = runAgentPageContext(
      runLoaderData({ status: "COMPLETED_WITH_ERRORS", completedAt }),
      NOW
    );

    expect(context?.page).toMatchObject({ status: "Failed" });
    expect(context?.signals).toEqual([
      { kind: "fresh_failure", runId: "run_abc123", failedAt: completedAt },
    ]);
  });

  it.each(["CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "EXPIRED"])(
    "treats %s as a failure",
    (status) => {
      const context = runAgentPageContext(
        runLoaderData({ status, completedAt: new Date(NOW - 60_000).toISOString() }),
        NOW
      );
      expect(context?.signals[0]?.kind).toBe("fresh_failure");
    }
  );

  it("emits no signal for a failure outside the freshness window", () => {
    const context = runAgentPageContext(
      runLoaderData({
        status: "COMPLETED_WITH_ERRORS",
        completedAt: new Date(NOW - FRESH_FAILURE_WINDOW_MS - 1000).toISOString(),
      }),
      NOW
    );

    expect(context?.signals).toEqual([]);
  });

  it("emits no signal for a failure with no timestamp", () => {
    const context = runAgentPageContext(
      runLoaderData({ status: "CRASHED", completedAt: null }),
      NOW
    );
    expect(context?.signals).toEqual([]);
  });

  it.each([
    ["PENDING", "Queued"],
    ["DELAYED", "Delayed"],
    ["PENDING_VERSION", "Pending version"],
  ])("emits waiting_run for %s", (status, label) => {
    const context = runAgentPageContext(runLoaderData({ status }), NOW);

    expect(context?.page).toMatchObject({ status: label });
    expect(context?.signals).toEqual([{ kind: "waiting_run", runId: "run_abc123" }]);
  });

  it("emits nothing for a healthy finished run", () => {
    const context = runAgentPageContext(
      runLoaderData({ status: "COMPLETED_SUCCESSFULLY", completedAt: new Date(NOW).toISOString() }),
      NOW
    );

    expect(context?.page).toMatchObject({ status: "Completed" });
    expect(context?.signals).toEqual([]);
  });

  it("takes the task id off this run's own span, not another run's", () => {
    const context = runAgentPageContext(
      runLoaderData({
        events: [
          { id: "span_root", runId: "run_parent", data: { message: "parent-task" } },
          { id: "span_1", runId: "run_abc123", data: { message: "child-task" } },
        ],
      }),
      NOW
    );

    expect(context?.page).toMatchObject({ taskId: "child-task" });
  });

  it("falls back to the anchor span when no span carries this run's id", () => {
    const context = runAgentPageContext(
      runLoaderData({ events: [{ id: "span_1", data: { message: "orphan-task" } }] }),
      NOW
    );

    expect(context?.page).toMatchObject({ taskId: "orphan-task" });
  });

  it("returns undefined rather than invent a task id", () => {
    expect(runAgentPageContext(runLoaderData({ events: [] }), NOW)).toBeUndefined();
    expect(
      runAgentPageContext({ run: { friendlyId: "run_x", status: "PENDING" } }, NOW)
    ).toBeUndefined();
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(runAgentPageContext(undefined, NOW)).toBeUndefined();
    expect(runAgentPageContext(null, NOW)).toBeUndefined();
    expect(runAgentPageContext({ nope: true }, NOW)).toBeUndefined();
  });
});

function queueLoaderData(queue: Partial<Record<string, unknown>> = {}) {
  return {
    queue: {
      id: "queue_1",
      name: "black-friday",
      type: "custom",
      paused: false,
      running: 1,
      queued: 0,
      concurrencyLimit: 10,
      ...queue,
    },
    fullName: "black-friday",
  };
}

describe("queueAgentPageContext", () => {
  it("names the queue and reports it healthy when nothing is waiting", () => {
    const context = queueAgentPageContext(queueLoaderData());

    expect(context).toEqual({
      page: { kind: "queue", name: "black-friday", health: "ok", paused: false },
      signals: [],
    });
    expect(agentPageContextSchema.safeParse(context).success).toBe(true);
  });

  // A watch the agent proposes off this context is validated against the stored name.
  it("names a task queue by its stored name, prefix and all", () => {
    const context = queueAgentPageContext(queueLoaderData({ type: "task", name: "send-receipt" }));
    expect(context?.page).toMatchObject({ kind: "queue", name: "task/send-receipt" });
  });

  it("emits no saturation signal when the queue is idle under its limit", () => {
    const context = queueAgentPageContext(queueLoaderData({ running: 10, queued: 0 }));
    expect(context?.signals).toEqual([]);
  });

  it("warns on a backlog that is not yet at capacity", () => {
    const context = queueAgentPageContext(queueLoaderData({ running: 4, queued: 6 }));

    expect(context?.page).toMatchObject({ health: "warn" });
    expect(context?.signals).toEqual([]);
  });

  it("emits concurrency_saturation at capacity with work waiting", () => {
    const context = queueAgentPageContext(queueLoaderData({ running: 10, queued: 3 }));

    expect(context?.page).toMatchObject({ health: "crit" });
    expect(context?.signals).toEqual([{ kind: "concurrency_saturation", severity: "warn" }]);
  });

  it("escalates to crit severity when the backlog is deeper than the limit", () => {
    const context = queueAgentPageContext(queueLoaderData({ running: 10, queued: 40 }));

    expect(context?.signals).toEqual([{ kind: "concurrency_saturation", severity: "crit" }]);
  });

  it("treats a paused queue as a warning with no saturation signal", () => {
    const context = queueAgentPageContext(queueLoaderData({ paused: true, running: 0, queued: 5 }));

    expect(context?.page).toMatchObject({ health: "warn" });
    expect(context?.signals).toEqual([]);
  });

  it("offers no watch on a paused queue, even when it is at capacity", () => {
    // Paused and saturated at once: nothing will drain or grow until it is resumed, so a
    // watch would promise an answer that can't come.
    const context = queueAgentPageContext(
      queueLoaderData({ paused: true, running: 10, queued: 40, concurrencyLimit: 10 })
    );

    expect(context?.signals).toEqual([]);
  });

  it("emits nothing for an unlimited queue, however deep the backlog", () => {
    const context = queueAgentPageContext(
      queueLoaderData({ concurrencyLimit: null, running: 99, queued: 99 })
    );

    expect(context?.page).toMatchObject({ health: "warn" });
    expect(context?.signals).toEqual([]);
  });

  it("emits nothing for a zero-limit queue, which has no capacity to be at", () => {
    const context = queueAgentPageContext(
      queueLoaderData({ concurrencyLimit: 0, running: 0, queued: 12 })
    );

    expect(context?.page).toMatchObject({ health: "warn" });
    expect(context?.signals).toEqual([]);
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(queueAgentPageContext(undefined)).toBeUndefined();
    expect(queueAgentPageContext({ queue: { name: "x" } })).toBeUndefined();
  });

  it("falls back to the environment limit for a queue with no limit of its own", () => {
    const context = queueAgentPageContext({
      ...queueLoaderData({ concurrencyLimit: null, running: 10, queued: 4 }),
      environmentConcurrencyLimit: 10,
    });

    expect(context?.page).toMatchObject({ health: "crit" });
    expect(context?.signals).toEqual([{ kind: "concurrency_saturation", severity: "warn" }]);
  });
});

function queueWaitLoaderData(
  wait: {
    oldestQueuedAt?: number | null;
    keys?: { queued: number; oldestEnqueuedAt: number }[];
  } = {},
  queue: Partial<Record<string, unknown>> = {}
) {
  return {
    ...queueLoaderData(queue),
    environmentConcurrencyLimit: 100,
    oldestQueuedAt: wait.oldestQueuedAt ?? null,
    loadedAt: NOW,
    ckBreakdown: { keys: wait.keys ?? [] },
  };
}

describe("queueAgentPageContext oldest wait", () => {
  it("warns when the head of the queue has waited past the threshold", () => {
    const context = queueAgentPageContext(
      queueWaitLoaderData({ oldestQueuedAt: NOW - QUEUE_OLDEST_WAIT_WARNING_MS - 1000 })
    );

    expect(context?.page).toMatchObject({ health: "warn" });
    expect(context?.signals).toEqual([]);
  });

  it("stays healthy for a wait under the threshold", () => {
    const context = queueAgentPageContext(
      queueWaitLoaderData({ oldestQueuedAt: NOW - 1000 }, { queued: 0 })
    );

    expect(context?.page).toMatchObject({ health: "ok" });
  });

  it("takes the worst wait across keys with a live backlog", () => {
    const context = queueAgentPageContext(
      queueWaitLoaderData({
        keys: [
          { queued: 0, oldestEnqueuedAt: NOW - 60 * 60_000 },
          { queued: 3, oldestEnqueuedAt: NOW - QUEUE_OLDEST_WAIT_WARNING_MS - 1 },
        ],
      })
    );

    expect(context?.page).toMatchObject({ health: "warn" });
  });

  it("ignores a drained key's stale enqueue time", () => {
    const context = queueAgentPageContext(
      queueWaitLoaderData(
        { keys: [{ queued: 0, oldestEnqueuedAt: NOW - 60 * 60_000 }] },
        { queued: 0 }
      )
    );

    expect(context?.page).toMatchObject({ health: "ok" });
  });

  it("stays healthy when the loader carries no wait fields at all", () => {
    const context = queueAgentPageContext(queueLoaderData({ queued: 0 }));

    expect(context?.page).toMatchObject({ health: "ok" });
    expect(context?.signals).toEqual([]);
  });
});

describe("queuesAgentPageContext", () => {
  const queuesLoaderData = (environment: Partial<Record<string, unknown>> = {}) => ({
    queues: [{ name: "black-friday" }],
    environment: {
      running: 1,
      queued: 0,
      concurrencyLimit: 10,
      burstFactor: 1,
      runsEnabled: true,
      ...environment,
    },
  });

  it("classifies the list and says nothing when the environment has room", () => {
    const context = queuesAgentPageContext(queuesLoaderData());

    expect(context).toEqual({ page: { kind: "queues" }, signals: [] });
    expect(agentPageContextSchema.safeParse(context).success).toBe(true);
  });

  it("emits no signal when the environment is at its limit with nothing waiting", () => {
    expect(queuesAgentPageContext(queuesLoaderData({ running: 10, queued: 0 }))?.signals).toEqual(
      []
    );
  });

  it("emits concurrency_saturation at the limit with work waiting", () => {
    expect(queuesAgentPageContext(queuesLoaderData({ running: 10, queued: 3 }))?.signals).toEqual([
      { kind: "concurrency_saturation", severity: "warn" },
    ]);
  });

  it("escalates to crit when the environment backlog is deeper than the limit", () => {
    expect(queuesAgentPageContext(queuesLoaderData({ running: 10, queued: 20 }))?.signals).toEqual([
      { kind: "concurrency_saturation", severity: "crit" },
    ]);
  });

  it("counts the burst limit, not the base limit", () => {
    const bursting = queuesLoaderData({ burstFactor: 2, running: 10, queued: 5 });
    expect(queuesAgentPageContext(bursting)?.signals).toEqual([]);

    const atBurst = queuesLoaderData({ burstFactor: 2, running: 20, queued: 5 });
    expect(queuesAgentPageContext(atBurst)?.signals).toEqual([
      { kind: "concurrency_saturation", severity: "warn" },
    ]);
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(queuesAgentPageContext(undefined)).toBeUndefined();
    expect(queuesAgentPageContext({ environment: { running: 1 } })).toBeUndefined();
  });
});

describe("errorsAgentPageContext", () => {
  it("classifies the errors list with no signals", () => {
    const context = errorsAgentPageContext();

    expect(context).toEqual({ page: { kind: "errors" }, signals: [] });
    expect(agentPageContextSchema.safeParse(context).success).toBe(true);
  });
});

describe("errorAgentPageContext", () => {
  it("names the error group by fingerprint", () => {
    const context = errorAgentPageContext({
      fingerprint: "9f2c1a",
      organizationSlug: "acme",
      canReplayRuns: true,
    });

    expect(context).toEqual({
      page: { kind: "error", fingerprint: "9f2c1a" },
      signals: [],
    });
    expect(agentPageContextSchema.safeParse(context).success).toBe(true);
  });

  it("returns undefined without a fingerprint to name", () => {
    expect(errorAgentPageContext(undefined)).toBeUndefined();
    expect(errorAgentPageContext({ fingerprint: "" })).toBeUndefined();
    expect(errorAgentPageContext({ organizationSlug: "acme" })).toBeUndefined();
  });
});

describe("deploymentsAgentPageContext", () => {
  it("classifies the deployments list with no signals", () => {
    const context = deploymentsAgentPageContext();

    expect(context).toEqual({ page: { kind: "deployments" }, signals: [] });
    expect(agentPageContextSchema.safeParse(context).success).toBe(true);
  });
});

describe("deploymentAgentPageContext", () => {
  it("names the deployment and its status", () => {
    const context = deploymentAgentPageContext({
      deployment: { version: "20260727.1", status: "DEPLOYED", shortCode: "abcd" },
      eventStream: null,
    });

    expect(context).toEqual({
      page: { kind: "deployment", version: "20260727.1", status: "DEPLOYED" },
      signals: [],
    });
    expect(agentPageContextSchema.safeParse(context).success).toBe(true);
  });

  it("passes a failed status through without inventing a signal", () => {
    const context = deploymentAgentPageContext({
      deployment: { version: "20260727.2", status: "FAILED" },
    });

    expect(context?.page).toMatchObject({ status: "FAILED" });
    expect(context?.signals).toEqual([]);
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(deploymentAgentPageContext(undefined)).toBeUndefined();
    expect(deploymentAgentPageContext({ deployment: { version: "20260727.1" } })).toBeUndefined();
  });
});

function expectValid(context: unknown) {
  expect(agentPageContextSchema.safeParse(context).success).toBe(true);
  return context as { page: Record<string, unknown>; signals: unknown[] };
}

describe("sectionAgentPageContext", () => {
  const kinds: SectionPageKind[] = [
    "tasks",
    "apikeys",
    "envvars",
    "concurrency",
    "regions",
    "settings",
    "logs",
    "query",
  ];

  it.each(kinds)("classifies %s with no signals", (kind) => {
    const context = sectionAgentPageContext(kind);
    expect(context).toEqual({ page: { kind }, signals: [] });
    expectValid(context);
  });
});

function taskLoaderData(overrides: Record<string, unknown> = {}) {
  return {
    task: {
      slug: "process-order",
      filePath: "src/trigger/orders.ts",
      triggerSource: "STANDARD",
      queue: { friendlyId: "queue_1", name: "orders", concurrencyLimit: 10, paused: false },
      ...(overrides.task as Record<string, unknown> | undefined),
    },
    activity: {},
    runList: {},
    ...overrides,
  };
}

describe("taskAgentPageContext", () => {
  it("names the task, its trigger source and its queue", () => {
    const context = expectValid(taskAgentPageContext(taskLoaderData()));

    expect(context.page).toEqual({
      kind: "task",
      taskId: "process-order",
      triggerSource: "STANDARD",
      queue: "orders",
      queuePaused: false,
    });
    expect(context.signals).toEqual([]);
  });

  it("reports a paused queue", () => {
    const context = taskAgentPageContext(
      taskLoaderData({ task: { slug: "x", queue: { name: "orders", paused: true } } })
    );
    expect(context?.page).toMatchObject({ queuePaused: true });
  });

  it("omits the queue entirely for a task that has none", () => {
    const context = taskAgentPageContext(taskLoaderData({ task: { slug: "x", queue: null } }));
    expect(context?.page).toEqual({ kind: "task", taskId: "x" });
  });

  it("counts a scheduled task's schedules, and how many are enabled", () => {
    const context = taskAgentPageContext(
      taskLoaderData({
        task: { slug: "nightly", triggerSource: "SCHEDULED", queue: null },
        scheduleList: {
          totalCount: 3,
          schedules: [{ active: true }, { active: false }, { active: false }],
        },
      })
    );

    expect(context?.page).toMatchObject({
      triggerSource: "SCHEDULED",
      schedules: { total: 3, active: 1 },
    });
  });

  it("reports zero schedules for a scheduled task with none attached", () => {
    const context = taskAgentPageContext(
      taskLoaderData({
        task: { slug: "nightly", triggerSource: "SCHEDULED", queue: null },
        scheduleList: { totalCount: 0, schedules: [] },
      })
    );

    expect(context?.page).toMatchObject({ schedules: { total: 0, active: 0 } });
  });

  it("says nothing about schedules when the loader has no schedule list", () => {
    const context = taskAgentPageContext(taskLoaderData());
    expect(context?.page).not.toHaveProperty("schedules");
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(taskAgentPageContext(undefined)).toBeUndefined();
    expect(taskAgentPageContext({ task: {} })).toBeUndefined();
    expect(taskAgentPageContext({ task: { slug: "" } })).toBeUndefined();
  });
});

function scheduleLoaderData(overrides: Record<string, unknown> = {}) {
  return {
    schedule: {
      id: "sched_internal",
      friendlyId: "sched_abc",
      taskIdentifier: "nightly-report",
      active: true,
      cron: "0 3 * * *",
      nextRuns: ["2026-08-04T03:00:00.000Z"],
      runs: [],
      ...overrides,
    },
  };
}

describe("scheduleAgentPageContext", () => {
  it("names the schedule and the task it fires", () => {
    const context = expectValid(scheduleAgentPageContext(scheduleLoaderData(), NOW));

    expect(context.page).toEqual({
      kind: "schedule",
      scheduleId: "sched_abc",
      taskId: "nightly-report",
      active: true,
    });
    expect(context.signals).toEqual([]);
  });

  it("reports a disabled schedule without inventing a signal", () => {
    const context = scheduleAgentPageContext(
      scheduleLoaderData({ active: false, nextRuns: [] }),
      NOW
    );

    expect(context?.page).toMatchObject({ active: false });
    expect(context?.signals).toEqual([]);
  });

  it("emits fresh_failure when the newest run just failed", () => {
    const finishedAt = new Date(NOW - 4 * 60_000).toISOString();
    const context = scheduleAgentPageContext(
      scheduleLoaderData({
        runs: [
          { friendlyId: "run_new", status: "COMPLETED_WITH_ERRORS", finishedAt },
          { friendlyId: "run_old", status: "COMPLETED_SUCCESSFULLY", finishedAt },
        ],
      }),
      NOW
    );

    expect(context?.signals).toEqual([
      { kind: "fresh_failure", runId: "run_new", failedAt: finishedAt },
    ]);
  });

  it("ignores an older failure the schedule has since recovered from", () => {
    const context = scheduleAgentPageContext(
      scheduleLoaderData({
        runs: [
          {
            friendlyId: "run_new",
            status: "COMPLETED_SUCCESSFULLY",
            finishedAt: new Date(NOW - 60_000).toISOString(),
          },
          {
            friendlyId: "run_old",
            status: "CRASHED",
            finishedAt: new Date(NOW - 120_000).toISOString(),
          },
        ],
      }),
      NOW
    );

    expect(context?.signals).toEqual([]);
  });

  it("emits nothing for a failure outside the freshness window, or with no timestamp", () => {
    const stale = scheduleAgentPageContext(
      scheduleLoaderData({
        runs: [
          {
            friendlyId: "run_1",
            status: "CRASHED",
            finishedAt: new Date(NOW - FRESH_FAILURE_WINDOW_MS - 1000).toISOString(),
          },
        ],
      }),
      NOW
    );
    expect(stale?.signals).toEqual([]);

    const undated = scheduleAgentPageContext(
      scheduleLoaderData({ runs: [{ friendlyId: "run_1", status: "CRASHED", finishedAt: null }] }),
      NOW
    );
    expect(undated?.signals).toEqual([]);
  });

  it("returns undefined for a schedule that isn't there", () => {
    expect(scheduleAgentPageContext({ schedule: null }, NOW)).toBeUndefined();
    expect(scheduleAgentPageContext(undefined, NOW)).toBeUndefined();
    expect(scheduleAgentPageContext({ schedule: { friendlyId: "s" } }, NOW)).toBeUndefined();
  });
});

describe("batchesAgentPageContext", () => {
  const batchesLoaderData = (
    batches: { friendlyId: string; status: string }[],
    hasFilters = false
  ) => ({
    batches,
    pagination: {},
    filters: { statuses: [] },
    hasFilters,
    hasAnyBatches: batches.length > 0,
  });

  it("says nothing when the newest batch came out clean", () => {
    const context = expectValid(
      batchesAgentPageContext(
        batchesLoaderData([
          { friendlyId: "batch_new", status: "COMPLETED" },
          { friendlyId: "batch_old", status: "PARTIAL_FAILED" },
        ])
      )
    );

    expect(context.page).toEqual({ kind: "batches" });
    expect(context.signals).toEqual([]);
  });

  it.each(["PARTIAL_FAILED", "ABORTED"])("names the newest batch when it is %s", (status) => {
    const context = batchesAgentPageContext(
      batchesLoaderData([{ friendlyId: "batch_new", status }])
    );
    expect(context?.page).toMatchObject({ latestFailedBatchId: "batch_new" });
  });

  it("says nothing on a filtered list, where the top row isn't the newest batch", () => {
    const context = batchesAgentPageContext(
      batchesLoaderData([{ friendlyId: "batch_new", status: "ABORTED" }], true)
    );
    expect(context?.page).toEqual({ kind: "batches" });
  });

  it("classifies an empty list", () => {
    expect(batchesAgentPageContext(batchesLoaderData([]))?.page).toEqual({ kind: "batches" });
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(batchesAgentPageContext(undefined)).toBeUndefined();
    expect(batchesAgentPageContext({ batches: [{ friendlyId: "b" }] })).toBeUndefined();
  });
});

describe("batchAgentPageContext", () => {
  const batchLoaderData = (overrides: Record<string, unknown> = {}) => ({
    batch: {
      id: "internal",
      friendlyId: "batch_abc",
      status: "COMPLETED",
      runCount: 10,
      successfulRunCount: 10,
      failedRunCount: 0,
      hasFinished: true,
      errors: [],
      ...overrides,
    },
  });

  it("names the batch, its status and its failure count", () => {
    const context = expectValid(batchAgentPageContext(batchLoaderData()));

    expect(context.page).toEqual({
      kind: "batch",
      batchId: "batch_abc",
      status: "COMPLETED",
      failedRunCount: 0,
    });
    expect(context.signals).toEqual([]);
  });

  it("carries a partial failure through without inventing a signal", () => {
    const context = batchAgentPageContext(
      batchLoaderData({ status: "PARTIAL_FAILED", failedRunCount: 3 })
    );

    expect(context?.page).toMatchObject({ status: "PARTIAL_FAILED", failedRunCount: 3 });
    expect(context?.signals).toEqual([]);
  });

  it("omits the count when the loader has none", () => {
    const context = batchAgentPageContext(batchLoaderData({ failedRunCount: null }));
    expect(context?.page).not.toHaveProperty("failedRunCount");
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(batchAgentPageContext(undefined)).toBeUndefined();
    expect(batchAgentPageContext({ batch: { friendlyId: "batch_abc" } })).toBeUndefined();
  });
});

describe("testAgentPageContext", () => {
  it("classifies the picker, which has no task to name", () => {
    const context = expectValid(testAgentPageContext({ tasks: [{ taskIdentifier: "a" }] }));
    expect(context.page).toEqual({ kind: "test" });
  });

  it("names the task under test and reports its queue", () => {
    const context = expectValid(
      testAgentPageContext({
        foundTask: true,
        triggerSource: "STANDARD",
        task: { id: "1", taskIdentifier: "process-order", filePath: "a.ts", friendlyId: "t_1" },
        queue: { id: "q", name: "orders", type: "task", paused: false },
        runs: [],
      })
    );

    expect(context.page).toEqual({ kind: "test", taskId: "process-order", queuePaused: false });
  });

  it("reports a paused queue, which would swallow the test run", () => {
    const context = testAgentPageContext({
      task: { taskIdentifier: "process-order" },
      queue: { name: "orders", paused: true },
    });

    expect(context?.page).toMatchObject({ taskId: "process-order", queuePaused: true });
  });

  it("classifies a task page whose task wasn't found", () => {
    expect(testAgentPageContext({ foundTask: false, regions: [] })?.page).toEqual({ kind: "test" });
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(testAgentPageContext(undefined)).toBeUndefined();
    expect(testAgentPageContext({ task: { taskIdentifier: "" } })).toBeUndefined();
  });
});

describe("alertsAgentPageContext", () => {
  const alertsLoaderData = (enabled: boolean[]) => ({
    alertChannels: enabled.map((flag, index) => ({
      id: `chan_${index}`,
      friendlyId: `alert_${index}`,
      name: `channel ${index}`,
      type: "EMAIL",
      enabled: flag,
      alertTypes: ["TASK_RUN"],
    })),
    limits: { used: enabled.length, limit: 10 },
  });

  it("counts the channels and says nothing when they are all on", () => {
    const context = expectValid(alertsAgentPageContext(alertsLoaderData([true, true])));

    expect(context.page).toEqual({ kind: "alerts", channelCount: 2, disabledChannelCount: 0 });
    expect(context.signals).toEqual([]);
  });

  it("counts the channels that are switched off", () => {
    const context = alertsAgentPageContext(alertsLoaderData([true, false, false]));
    expect(context?.page).toMatchObject({ channelCount: 3, disabledChannelCount: 2 });
  });

  it("classifies an environment with no alerting at all", () => {
    expect(alertsAgentPageContext(alertsLoaderData([]))?.page).toMatchObject({ channelCount: 0 });
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(alertsAgentPageContext(undefined)).toBeUndefined();
    expect(alertsAgentPageContext({ limits: { used: 0, limit: 1 } })).toBeUndefined();
  });
});

describe("waitpointsAgentPageContext", () => {
  const tokensLoaderData = (tokens: Record<string, unknown>[]) => ({
    success: true,
    tokens,
    pagination: {},
    hasFilters: false,
    hasAnyTokens: tokens.length > 0,
  });

  it("counts nothing stuck on a healthy list", () => {
    const context = expectValid(
      waitpointsAgentPageContext(
        tokensLoaderData([
          { id: "wp_1", status: "COMPLETED" },
          { id: "wp_2", status: "WAITING", timeoutAt: new Date(NOW + 60_000).toISOString() },
        ]),
        NOW
      )
    );

    expect(context.page).toEqual({ kind: "waitpoints", timedOutCount: 0, overdueCount: 0 });
    expect(context.signals).toEqual([]);
  });

  it("counts timed-out tokens", () => {
    const context = waitpointsAgentPageContext(
      tokensLoaderData([
        { id: "wp_1", status: "TIMED_OUT" },
        { id: "wp_2", status: "TIMED_OUT" },
      ]),
      NOW
    );

    expect(context?.page).toMatchObject({ timedOutCount: 2, overdueCount: 0 });
  });

  it("counts a token still waiting past its own timeout", () => {
    const context = waitpointsAgentPageContext(
      tokensLoaderData([
        { id: "wp_1", status: "WAITING", timeoutAt: new Date(NOW - 1000).toISOString() },
      ]),
      NOW
    );

    expect(context?.page).toMatchObject({ overdueCount: 1 });
  });

  it("falls back to completedAfter when timeoutAt is absent", () => {
    const context = waitpointsAgentPageContext(
      tokensLoaderData([
        { id: "wp_1", status: "WAITING", completedAfter: new Date(NOW - 1000).toISOString() },
      ]),
      NOW
    );

    expect(context?.page).toMatchObject({ overdueCount: 1 });
  });

  it("never calls a token with no timeout overdue", () => {
    const context = waitpointsAgentPageContext(
      tokensLoaderData([{ id: "wp_1", status: "WAITING" }]),
      NOW
    );

    expect(context?.page).toMatchObject({ overdueCount: 0 });
  });

  it("handles the presenter's failure variant, which carries no tokens", () => {
    const context = waitpointsAgentPageContext(
      { success: false, code: "ENGINE_VERSION_MISMATCH", error: "nope", tokens: [] },
      NOW
    );

    expect(context?.page).toEqual({ kind: "waitpoints", timedOutCount: 0, overdueCount: 0 });
  });

  it("names one token on the detail page", () => {
    const context = expectValid(
      waitpointsAgentPageContext(
        { waitpoint: { id: "wp_abc", status: "TIMED_OUT", type: "MANUAL", connectedRuns: [] } },
        NOW
      )
    );

    expect(context.page).toEqual({ kind: "waitpoints", tokenId: "wp_abc", status: "TIMED_OUT" });
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(waitpointsAgentPageContext(undefined, NOW)).toBeUndefined();
    expect(waitpointsAgentPageContext({ waitpoint: { id: "wp_1" } }, NOW)).toBeUndefined();
  });
});

describe("bulkActionsAgentPageContext", () => {
  it("counts the actions still in flight", () => {
    const context = expectValid(
      bulkActionsAgentPageContext({
        currentPage: 1,
        totalPages: 1,
        totalCount: 2,
        bulkActions: [{ status: "PENDING" }, { status: "COMPLETED" }],
        canAbort: true,
      })
    );

    expect(context.page).toEqual({ kind: "bulkactions", pendingCount: 1 });
    expect(context.signals).toEqual([]);
  });

  it("names one action, its status and its failures", () => {
    const context = expectValid(
      bulkActionsAgentPageContext({
        bulkAction: {
          friendlyId: "bulk_abc",
          name: null,
          status: "COMPLETED",
          type: "REPLAY",
          totalCount: 10,
          successCount: 7,
          failureCount: 3,
        },
        canAbort: false,
      })
    );

    expect(context.page).toEqual({
      kind: "bulkactions",
      bulkActionId: "bulk_abc",
      status: "COMPLETED",
      failedRunCount: 3,
    });
  });

  it("omits the failure count when the loader has none", () => {
    const context = bulkActionsAgentPageContext({
      bulkAction: { friendlyId: "bulk_abc", status: "PENDING", failureCount: null },
    });

    expect(context?.page).not.toHaveProperty("failedRunCount");
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(bulkActionsAgentPageContext(undefined)).toBeUndefined();
    expect(bulkActionsAgentPageContext({ bulkAction: { status: "PENDING" } })).toBeUndefined();
  });
});

describe("branchesAgentPageContext", () => {
  it("reports headroom", () => {
    const context = expectValid(
      branchesAgentPageContext({ branches: [], limits: { used: 1, limit: 5, isAtLimit: false } })
    );

    expect(context.page).toEqual({ kind: "branches", atLimit: false });
    expect(context.signals).toEqual([]);
  });

  it("reports the limit being reached", () => {
    const context = branchesAgentPageContext({ limits: { used: 5, limit: 5, isAtLimit: true } });
    expect(context?.page).toMatchObject({ atLimit: true });
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(branchesAgentPageContext(undefined)).toBeUndefined();
    expect(branchesAgentPageContext({ branches: [] })).toBeUndefined();
  });
});

describe("limitsAgentPageContext", () => {
  const quota = (
    name: string,
    currentUsage: number,
    limit: number | null,
    canExceed?: boolean
  ) => ({
    name,
    description: "",
    currentUsage,
    limit,
    source: "plan",
    ...(canExceed === undefined ? {} : { canExceed }),
  });

  it("names nothing when every quota has room", () => {
    const context = expectValid(
      limitsAgentPageContext({
        quotas: { branches: quota("Branches", 1, 5), schedules: quota("Schedules", 2, 10) },
      })
    );

    expect(context.page).toEqual({ kind: "limits" });
    expect(context.signals).toEqual([]);
  });

  it("names the quotas at or over their limit", () => {
    const context = limitsAgentPageContext({
      quotas: {
        branches: quota("Branches", 5, 5),
        schedules: quota("Schedules", 12, 10),
        projects: quota("Projects", 1, 5),
      },
    });

    expect(context?.page).toMatchObject({ exhausted: ["Branches", "Schedules"] });
  });

  it("ignores a soft quota, an unlimited quota and a null entry", () => {
    const context = limitsAgentPageContext({
      quotas: {
        soft: quota("Soft", 99, 10, true),
        unlimited: quota("Unlimited", 99, null),
        zero: quota("Zero", 0, 0),
        missing: null,
        junk: "nope",
      },
    });

    expect(context?.page).toEqual({ kind: "limits" });
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(limitsAgentPageContext(undefined)).toBeUndefined();
    expect(limitsAgentPageContext({ planName: "free" })).toBeUndefined();
  });
});

describe("dashboardsAgentPageContext", () => {
  it("names the dashboard the user is on", () => {
    const context = expectValid(
      dashboardsAgentPageContext({ key: "overview", title: "Run metrics", layout: {} })
    );

    expect(context.page).toEqual({ kind: "dashboards", title: "Run metrics" });
  });

  it("classifies the chooser, which has no title", () => {
    expect(dashboardsAgentPageContext({ ok: true })?.page).toEqual({ kind: "dashboards" });
    expect(dashboardsAgentPageContext(undefined)?.page).toEqual({ kind: "dashboards" });
  });
});

describe("agentsAgentPageContext", () => {
  it("names the agent", () => {
    const context = expectValid(
      agentsAgentPageContext({
        agent: { slug: "support-triage", filePath: "a.ts", triggerSource: "AGENT" },
      })
    );

    expect(context.page).toEqual({ kind: "agents", agentId: "support-triage" });
    expect(context.signals).toEqual([]);
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(agentsAgentPageContext(undefined)).toBeUndefined();
    expect(agentsAgentPageContext({ agent: { slug: "" } })).toBeUndefined();
  });
});

describe("playgroundAgentPageContext", () => {
  it("names the agent being tried", () => {
    const context = expectValid(playgroundAgentPageContext({ agent: { slug: "support-triage" } }));
    expect(context.page).toEqual({ kind: "playground", agentId: "support-triage" });
  });

  it("classifies the picker, which has no agent selected", () => {
    expect(playgroundAgentPageContext({ agents: [], versions: [] })?.page).toEqual({
      kind: "playground",
    });
    expect(playgroundAgentPageContext(undefined)?.page).toEqual({ kind: "playground" });
  });
});

describe("promptsAgentPageContext", () => {
  it("counts the prompts pinned to an override", () => {
    const context = expectValid(
      promptsAgentPageContext({
        prompts: [
          { slug: "a", hasOverride: false },
          { slug: "b", hasOverride: true },
        ],
        sparklines: {},
      })
    );

    expect(context.page).toEqual({ kind: "prompts", overriddenCount: 1 });
    expect(context.signals).toEqual([]);
  });

  it("reports whether one prompt has an override live", () => {
    const overridden = promptsAgentPageContext({
      prompt: { slug: "summarise" },
      overrideVersion: { id: "v", version: 3 },
    });
    expect(overridden?.page).toEqual({ kind: "prompts", slug: "summarise", overridden: true });

    const clean = promptsAgentPageContext({
      prompt: { slug: "summarise" },
      overrideVersion: null,
    });
    expect(clean?.page).toEqual({ kind: "prompts", slug: "summarise", overridden: false });
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(promptsAgentPageContext(undefined)).toBeUndefined();
    expect(promptsAgentPageContext({ prompt: { slug: "" } })).toBeUndefined();
  });
});

describe("modelsAgentPageContext", () => {
  it("names the model", () => {
    const context = expectValid(
      modelsAgentPageContext({ model: { modelName: "claude-sonnet-4-6", provider: "anthropic" } })
    );

    expect(context.page).toEqual({ kind: "models", modelId: "claude-sonnet-4-6" });
  });

  it("classifies the registry and the comparison, which name no single model", () => {
    expect(modelsAgentPageContext({ catalog: [], projectUsage: [] })?.page).toEqual({
      kind: "models",
    });
    expect(modelsAgentPageContext({ comparison: [], models: ["a", "b"] })?.page).toEqual({
      kind: "models",
    });
    expect(modelsAgentPageContext(undefined)?.page).toEqual({ kind: "models" });
  });
});

describe("sessionsAgentPageContext", () => {
  it("counts sessions that expired instead of closing", () => {
    const context = expectValid(
      sessionsAgentPageContext({
        sessions: [{ status: "ACTIVE" }, { status: "EXPIRED" }, { status: "CLOSED" }],
        pagination: {},
        hasFilters: false,
        hasAnySessions: true,
      })
    );

    expect(context.page).toEqual({ kind: "sessions", expiredCount: 1 });
    expect(context.signals).toEqual([]);
  });

  it("names the session and its current run", () => {
    const context = expectValid(
      sessionsAgentPageContext({
        session: {
          friendlyId: "session_abc",
          taskIdentifier: "support-triage",
          currentRun: { friendlyId: "run_1", status: "CRASHED" },
          runs: [],
        },
      })
    );

    expect(context.page).toEqual({
      kind: "sessions",
      sessionId: "session_abc",
      runId: "run_1",
      runStatus: "CRASHED",
    });
    expect(context.signals).toEqual([]);
  });

  it("omits the run when the session has none", () => {
    const context = sessionsAgentPageContext({
      session: { friendlyId: "session_abc", currentRun: null },
    });

    expect(context?.page).toEqual({ kind: "sessions", sessionId: "session_abc" });
  });

  it("returns undefined for data it doesn't recognise", () => {
    expect(sessionsAgentPageContext(undefined)).toBeUndefined();
    expect(sessionsAgentPageContext({ session: { taskIdentifier: "x" } })).toBeUndefined();
  });
});
