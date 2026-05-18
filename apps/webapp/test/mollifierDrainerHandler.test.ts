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

  it("propagates engine.trigger errors so MollifierDrainer can classify them", async () => {
    const trigger = vi.fn(async () => {
      throw new Error("boom");
    });
    const handler = createDrainerHandler({
      engine: { trigger } as any,
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
    ).rejects.toThrow("boom");
  });
});
