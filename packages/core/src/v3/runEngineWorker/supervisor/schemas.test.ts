import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import {
  WorkerApiRunRestoreOutcomeRequestBody,
  WorkerApiSuspendRunResponseBody,
} from "./schemas.js";

describe("WorkerApiRunRestoreOutcomeRequestBody", () => {
  it("rejects an oversized reason or message", () => {
    const base = { outcome: "fail", reason: "NodeLost", message: "gone" };

    expect(WorkerApiRunRestoreOutcomeRequestBody.safeParse(base).success).toBe(true);
    expect(
      WorkerApiRunRestoreOutcomeRequestBody.safeParse({ ...base, reason: "x".repeat(257) }).success
    ).toBe(false);
    expect(
      WorkerApiRunRestoreOutcomeRequestBody.safeParse({
        ...base,
        message: "x".repeat(16 * 1024 + 1),
      }).success
    ).toBe(false);
  });

  // The platform alone picks where a fallback goes.
  it("strips a worker queue the worker sends", () => {
    const parsed = WorkerApiRunRestoreOutcomeRequestBody.parse({
      outcome: "fallback",
      reason: "TemplateNotFound",
      workerQueue: "someone-elses-queue",
      fallbackWorkerQueue: "someone-elses-queue",
    });

    expect(parsed).toEqual({ outcome: "fallback", reason: "TemplateNotFound" });
  });

  // An older supervisor still attaches the retired client route; it is stripped, not rejected.
  it("strips a legacy snapshotRoute", () => {
    const parsed = WorkerApiRunRestoreOutcomeRequestBody.parse({
      outcome: "requeue",
      reason: "NodeLost",
      snapshotRoute: { version: 1, residency: "redis-primary", organizationId: "org_123" },
    });

    expect(parsed).not.toHaveProperty("snapshotRoute");
  });
});

describe("WorkerApiSuspendRunResponseBody", () => {
  const discarded = { ok: true, discarded: { error: "Not the latest snapshot" } };

  // Catches: a discard answer that a caller on an older core reads as a failed submit and resends.
  it("still reads as delivered to a caller on the shape before discards were reported", () => {
    const previous = z.object({ ok: z.literal(true) });
    expect(previous.safeParse(discarded).success).toBe(true);
  });

  // Catches: the current schema stripping `discarded`, so the supervisor treats a discard as stored.
  it("keeps the discard reason", () => {
    expect(WorkerApiSuspendRunResponseBody.parse(discarded)).toEqual(discarded);
  });
});
