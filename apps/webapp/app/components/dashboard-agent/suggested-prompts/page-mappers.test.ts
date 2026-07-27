import { agentPageContextSchema } from "@internal/dashboard-agent-contracts";
import { describe, expect, it } from "vitest";
import {
  FRESH_FAILURE_WINDOW_MS,
  queueAgentPageContext,
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
});
