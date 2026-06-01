import { describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { RunId } from "@trigger.dev/core/v3/isomorphic";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

// `writeMollifierTerminalFailureRow` enqueues a PerformTaskRunAlertsService
// after writing the SYSTEM_FAILURE row (mirrors TriggerFailedTaskService).
// In production that enqueues into the alerts redis-worker; the test
// environment has no redis-worker, so the real call hangs the tick out
// to its 5s vitest timeout. Stub `enqueue` to a resolved no-op so the
// handler's best-effort try/catch sees a clean success path.
vi.mock("~/v3/services/alerts/performTaskRunAlerts.server", () => ({
  PerformTaskRunAlertsService: {
    enqueue: vi.fn(async () => undefined),
  },
}));

import {
  createDrainerHandler,
  isRetryablePgError,
} from "~/v3/mollifier/mollifierDrainerHandler.server";

describe("isRetryablePgError", () => {
  it("returns true for P2024 (connection pool timeout)", () => {
    const err = Object.assign(new Error("Timed out fetching a new connection"), {
      code: "P2024",
    });
    expect(isRetryablePgError(err)).toBe(true);
  });

  it("returns true for generic connection-lost messages", () => {
    expect(isRetryablePgError(new Error("Connection lost"))).toBe(true);
    expect(isRetryablePgError(new Error("Can't reach database server"))).toBe(true);
  });

  it("returns false for validation errors", () => {
    expect(isRetryablePgError(new Error("Invalid payload"))).toBe(false);
  });

  it("returns false for non-Error inputs", () => {
    expect(isRetryablePgError("string error")).toBe(false);
    expect(isRetryablePgError({ message: "object" })).toBe(false);
  });
});

describe("createDrainerHandler", () => {
  it("invokes engine.trigger with the deserialised snapshot", async () => {
    const trigger = vi.fn(async () => ({ friendlyId: "run_x" }));
    const handler = createDrainerHandler({
      engine: { trigger } as any,
      prisma: {} as any,
    });

    await handler({
      runId: "run_x",
      envId: "env_a",
      orgId: "org_1",
      payload: { taskIdentifier: "t", payload: "{}" },
      attempts: 0,
      createdAt: new Date(),
    } as any);

    expect(trigger).toHaveBeenCalledOnce();
    const callArg = trigger.mock.calls[0][0] as { taskIdentifier: string };
    expect(callArg.taskIdentifier).toBe("t");
  });

  it("re-attaches the snapshot's traceId so engine.trigger inherits the original trace", async () => {
    // Captures the active traceId at the moment engine.trigger is invoked.
    // Without context propagation it would be a fresh traceId, leaving the
    // run-detail page with only the root span.
    let observedTraceId: string | undefined;
    const trigger = vi.fn(async () => {
      observedTraceId = trace.getActiveSpan()?.spanContext().traceId;
      return { friendlyId: "run_x" };
    });

    const handler = createDrainerHandler({
      engine: { trigger } as any,
      prisma: {} as any,
    });

    const snapshotTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const snapshotSpanId = "bbbbbbbbbbbbbbbb";

    await handler({
      runId: "run_x",
      envId: "env_a",
      orgId: "org_1",
      payload: {
        taskIdentifier: "t",
        traceId: snapshotTraceId,
        spanId: snapshotSpanId,
      },
      attempts: 0,
      createdAt: new Date(),
    } as any);

    expect(observedTraceId).toBe(snapshotTraceId);
  });

  it("rethrows retryable PG errors so MollifierDrainer requeues the entry", async () => {
    const err = new Error("Can't reach database server");
    const trigger = vi.fn(async () => {
      throw err;
    });
    const createFailedTaskRun = vi.fn();
    const handler = createDrainerHandler({
      engine: { trigger, createFailedTaskRun } as any,
      prisma: {} as any,
    });

    await expect(
      handler({
        runId: "run_x",
        envId: "env_a",
        orgId: "org_1",
        payload: { taskIdentifier: "t" },
        attempts: 0,
        createdAt: new Date(),
      } as any),
    ).rejects.toThrow("Can't reach database server");
    // Retryable: we do NOT write a SYSTEM_FAILURE row, the entry should
    // be requeued for another shot.
    expect(createFailedTaskRun).not.toHaveBeenCalled();
  });

  const envFixture = {
    id: "env_a",
    type: "DEVELOPMENT",
    project: { id: "proj_1" },
    organization: { id: "org_1" },
  };

  it("writes a SYSTEM_FAILURE PG row when engine.trigger fails non-retryably", async () => {
    const trigger = vi.fn(async () => {
      throw new Error("validation failed: payload too large");
    });
    const createFailedTaskRun = vi.fn(async () => ({
      id: "internal",
      friendlyId: "run_x",
    }));
    const handler = createDrainerHandler({
      engine: { trigger, createFailedTaskRun } as any,
      prisma: {} as any,
    });

    await expect(
      handler({
        runId: "run_x",
        envId: "env_a",
        orgId: "org_1",
        payload: { taskIdentifier: "t", environment: envFixture },
        attempts: 0,
        createdAt: new Date(),
      } as any),
    ).resolves.toBeUndefined();

    expect(trigger).toHaveBeenCalledOnce();
    expect(createFailedTaskRun).toHaveBeenCalledOnce();
    const arg = createFailedTaskRun.mock.calls[0][0] as { error: { raw: string } };
    expect(arg.error.raw).toContain("validation failed");
  });

  it("propagates the batch association into createFailedTaskRun (so batch parents don't hang on missing children)", async () => {
    // Devin's ANALYSIS report on PR #3754: the terminal-failure path
    // extracts most snapshot fields (parentTaskRunId, rootTaskRunId,
    // depth, etc.) but dropped `batch`. If the original trigger was
    // part of a batch, the SYSTEM_FAILURE row isn't associated with
    // the batch, so the batch parent's completion-tracking can hang
    // indefinitely waiting on a child that landed but isn't linked.
    const trigger = vi.fn(async () => {
      throw new Error("validation failed: payload too large");
    });
    const createFailedTaskRun = vi.fn(async () => ({
      id: "internal",
      friendlyId: "run_x",
    }));
    const handler = createDrainerHandler({
      engine: { trigger, createFailedTaskRun } as any,
      prisma: {} as any,
    });

    await expect(
      handler({
        runId: "run_batched",
        envId: "env_a",
        orgId: "org_1",
        payload: {
          taskIdentifier: "t",
          environment: envFixture,
          batch: { id: "batch_xyz", index: 7 },
        },
        attempts: 0,
        createdAt: new Date(),
      } as any),
    ).resolves.toBeUndefined();

    expect(createFailedTaskRun).toHaveBeenCalledOnce();
    const arg = createFailedTaskRun.mock.calls[0][0] as {
      batch?: { id: string; index: number };
    };
    expect(arg.batch).toEqual({ id: "batch_xyz", index: 7 });
  });

  it("rethrows the original error when createFailedTaskRun also fails (PG genuinely unreachable)", async () => {
    const triggerErr = new Error("engine rejected the snapshot");
    const trigger = vi.fn(async () => {
      throw triggerErr;
    });
    const createFailedTaskRun = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const handler = createDrainerHandler({
      engine: { trigger, createFailedTaskRun } as any,
      prisma: {} as any,
    });

    await expect(
      handler({
        runId: "run_x",
        envId: "env_a",
        orgId: "org_1",
        payload: { taskIdentifier: "t", environment: envFixture },
        attempts: 0,
        createdAt: new Date(),
      } as any),
    ).rejects.toThrow("engine rejected the snapshot");
    // Drainer's outer drainOne loop now decides retry vs buffer.fail.
    expect(createFailedTaskRun).toHaveBeenCalledOnce();
  });

  it("calls createCancelledRun with emitRunCancelledEvent: false (suppresses orphan trace-event log noise)", async () => {
    // Buffered-only runs never had a primary trace event written for
    // them — the mollifier gate skipped `repository.traceEvent` since
    // the run hadn't materialised in PG yet. The `runCancelled` handler
    // would log `[runCancelled] Failed to cancel run event` for every
    // cancelled buffered run if we let the emit fire. Suppress it.
    const friendlyId = RunId.generate().friendlyId;
    const createCancelledRun = vi.fn(async () => ({
      id: "internal",
      friendlyId,
      status: "CANCELED",
    }));
    const handler = createDrainerHandler({
      engine: { createCancelledRun } as any,
      prisma: {} as any,
    });

    await handler({
      runId: friendlyId,
      envId: "env_a",
      orgId: "org_1",
      payload: {
        friendlyId,
        taskIdentifier: "t",
        environment: envFixture,
        cancelledAt: new Date().toISOString(),
        cancelReason: "Canceled by user",
      },
      attempts: 0,
      createdAt: new Date(),
    } as any);

    expect(createCancelledRun).toHaveBeenCalledOnce();
    const arg = createCancelledRun.mock.calls[0][0] as {
      emitRunCancelledEvent?: boolean;
    };
    expect(arg.emitRunCancelledEvent).toBe(false);
  });

  it("honours the cancel when a buffered cancel races a materialised non-CANCELED row", async () => {
    // Cancel-wins-over-trigger. If the normal trigger
    // replay path materialised a live PENDING row before the cancel
    // bifurcation drained, engine.createCancelledRun throws a conflict —
    // its documented contract is that "the caller must decide between
    // engine.cancelRun() and skipping". The drainer handler must honour
    // the cancel intent by actually cancelling the now-live run; otherwise
    // the conflict propagates, isRetryablePgError() returns false, and the
    // drainer buffer.fail()s the entry — silently losing the cancellation
    // while the run keeps executing.
    const friendlyId = RunId.generate().friendlyId;
    const createCancelledRun = vi.fn(async () => {
      throw new Error(
        `createCancelledRun conflict: existing run ${friendlyId} has status PENDING`
      );
    });
    const cancelRun = vi.fn(async () => ({ alreadyFinished: false }));
    const handler = createDrainerHandler({
      engine: { createCancelledRun, cancelRun } as any,
      prisma: {} as any,
    });

    await expect(
      handler({
        runId: friendlyId,
        envId: "env_a",
        orgId: "org_1",
        payload: {
          friendlyId,
          taskIdentifier: "t",
          environment: envFixture,
          cancelledAt: new Date().toISOString(),
          cancelReason: "Canceled by user",
        },
        attempts: 0,
        createdAt: new Date(),
      } as any)
    ).resolves.toBeUndefined();

    // The live run is actually cancelled, by its internal id.
    expect(cancelRun).toHaveBeenCalledOnce();
    expect(cancelRun.mock.calls[0][0].runId).toBe(RunId.fromFriendlyId(friendlyId));
  });

  it("requeues on a transient PG outage during the SYSTEM_FAILURE fallback write", async () => {
    // engine.trigger failed non-retryably, so we try to write a terminal
    // SYSTEM_FAILURE row. If THAT write fails because PG is transiently
    // unreachable, rethrowing the *original* non-retryable error makes the
    // drainer buffer.fail() the entry — losing the run with no PG row ever
    // landing. Rethrow the retryable write error instead so the drainer
    // requeues; once PG recovers the failure row lands and the customer
    // sees it.
    const trigger = vi.fn(async () => {
      throw new Error("validation failed: payload too large");
    });
    const createFailedTaskRun = vi.fn(async () => {
      throw new Error("Can't reach database server");
    });
    const handler = createDrainerHandler({
      engine: { trigger, createFailedTaskRun } as any,
      prisma: {} as any,
    });

    await expect(
      handler({
        runId: "run_x",
        envId: "env_a",
        orgId: "org_1",
        payload: { taskIdentifier: "t", environment: envFixture },
        attempts: 0,
        createdAt: new Date(),
      } as any)
    ).rejects.toThrow("Can't reach database server");
  });

  it("writes a SYSTEM_FAILURE row when createCancelledRun fails non-retryably (cancel bifurcation)", async () => {
    // Without this guard a non-conflict, non-retryable failure from
    // createCancelledRun rethrows out of the handler. The drainer's
    // onTerminalFailure gates on cause==="max-attempts-exhausted" and
    // skips "non-retryable", so buffer.fail() deletes the entry with
    // no PG row written — the cancellation disappears silently.
    // Mirror the non-cancel path's SYSTEM_FAILURE fallback so the
    // customer always sees a terminal row.
    const friendlyId = RunId.generate().friendlyId;
    const cancelErr = new Error("validation failed: bad cancel snapshot");
    const createCancelledRun = vi.fn(async () => {
      throw cancelErr;
    });
    const createFailedTaskRun = vi.fn(async () => ({ id: "internal_x" }));
    const handler = createDrainerHandler({
      engine: { createCancelledRun, createFailedTaskRun } as any,
      prisma: {} as any,
    });

    await handler({
      runId: friendlyId,
      envId: "env_a",
      orgId: "org_1",
      payload: {
        friendlyId,
        taskIdentifier: "t",
        environment: envFixture,
        cancelledAt: new Date().toISOString(),
        cancelReason: "Canceled by user",
      },
      attempts: 0,
      createdAt: new Date(),
    } as any);

    // SYSTEM_FAILURE row was written via the shared helper. Handler
    // returns cleanly so the drainer ACKs the entry instead of
    // buffer.fail()ing it.
    expect(createFailedTaskRun).toHaveBeenCalledOnce();
    expect(createFailedTaskRun.mock.calls[0][0].friendlyId).toBe(friendlyId);
    expect(createFailedTaskRun.mock.calls[0][0].error.raw).toContain(
      "validation failed: bad cancel snapshot"
    );
  });

  it("requeues when createCancelledRun fails with a retryable PG error (cancel bifurcation)", async () => {
    // Retryable PG failures must rethrow so the drainer requeues the
    // entry — writing a SYSTEM_FAILURE row when PG is transiently
    // unreachable would still fail. The drainer's existing retry loop
    // handles the requeue.
    const friendlyId = RunId.generate().friendlyId;
    const cancelErr = new Error("Can't reach database server");
    const createCancelledRun = vi.fn(async () => {
      throw cancelErr;
    });
    const createFailedTaskRun = vi.fn();
    const handler = createDrainerHandler({
      engine: { createCancelledRun, createFailedTaskRun } as any,
      prisma: {} as any,
    });

    await expect(
      handler({
        runId: friendlyId,
        envId: "env_a",
        orgId: "org_1",
        payload: {
          friendlyId,
          taskIdentifier: "t",
          environment: envFixture,
          cancelledAt: new Date().toISOString(),
          cancelReason: "Canceled by user",
        },
        attempts: 0,
        createdAt: new Date(),
      } as any)
    ).rejects.toThrow("Can't reach database server");
    expect(createFailedTaskRun).not.toHaveBeenCalled();
  });

  it("rethrows the original error when the snapshot lacks an environment block", async () => {
    const triggerErr = new Error("engine rejected the snapshot");
    const trigger = vi.fn(async () => {
      throw triggerErr;
    });
    const createFailedTaskRun = vi.fn();
    const handler = createDrainerHandler({
      engine: { trigger, createFailedTaskRun } as any,
      prisma: {} as any,
    });

    await expect(
      handler({
        runId: "run_x",
        envId: "env_a",
        orgId: "org_1",
        payload: { taskIdentifier: "t" /* no environment */ },
        attempts: 0,
        createdAt: new Date(),
      } as any),
    ).rejects.toThrow("engine rejected the snapshot");
    expect(createFailedTaskRun).not.toHaveBeenCalled();
  });
});
