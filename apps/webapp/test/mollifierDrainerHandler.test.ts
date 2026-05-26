import { describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
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
