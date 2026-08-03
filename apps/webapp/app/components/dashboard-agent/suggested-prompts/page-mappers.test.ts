import { agentPageContextSchema } from "@internal/dashboard-agent-contracts";
import { describe, expect, it } from "vitest";
import {
  deploymentAgentPageContext,
  deploymentsAgentPageContext,
  errorAgentPageContext,
  errorsAgentPageContext,
  FRESH_FAILURE_WINDOW_MS,
  QUEUE_OLDEST_WAIT_WARNING_MS,
  queueAgentPageContext,
  queuesAgentPageContext,
  runAgentPageContext,
} from "./page-mappers";

const NOW = Date.parse("2026-07-27T10:25:41.000Z");

/** The run-detail loader payload, as it arrives on the route match (JSON, so ISO dates). */
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
      // Fields the real loader also returns, to prove the mapper ignores them.
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
      page: { kind: "queue", name: "black-friday", health: "ok" },
      signals: [],
    });
    expect(agentPageContextSchema.safeParse(context).success).toBe(true);
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

  it("emits nothing for an unlimited queue, however deep the backlog", () => {
    const context = queueAgentPageContext(
      queueLoaderData({ concurrencyLimit: null, running: 99, queued: 99 })
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

/** The queue-detail loader's live oldest-wait fields, which the page tints on. */
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
    // The wait alone is not a signal: the loader has no run id to point at.
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
