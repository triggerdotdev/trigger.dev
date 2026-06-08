import { describe, expect, it } from "vitest";
import { mapRunToLiveFields } from "~/presenters/v3/mapRunToLiveFields.server";

describe("mapRunToLiveFields", () => {
  it("maps an executing run with lockedAt fallback and non-final flags", () => {
    const updatedAt = new Date("2026-05-07T10:00:00.000Z");
    const lockedAt = new Date("2026-05-07T09:59:50.000Z");

    const result = mapRunToLiveFields({
      friendlyId: "run_123",
      status: "EXECUTING",
      updatedAt,
      startedAt: null,
      lockedAt,
      completedAt: null,
      usageDurationMs: BigInt(2500),
      costInCents: 10,
      baseCostInCents: 5,
    });

    expect(result).toEqual({
      friendlyId: "run_123",
      status: "EXECUTING",
      updatedAt: updatedAt.toISOString(),
      startedAt: lockedAt.toISOString(),
      finishedAt: undefined,
      hasFinished: false,
      isCancellable: true,
      isPending: false,
      usageDurationMs: 2500,
      costInCents: 10,
      baseCostInCents: 5,
    });
  });

  it("maps a final run and prefers completedAt for finishedAt", () => {
    const updatedAt = new Date("2026-05-07T10:00:00.000Z");
    const startedAt = new Date("2026-05-07T09:59:00.000Z");
    const completedAt = new Date("2026-05-07T09:59:30.000Z");

    const result = mapRunToLiveFields({
      friendlyId: "run_456",
      status: "COMPLETED_SUCCESSFULLY",
      updatedAt,
      startedAt,
      lockedAt: null,
      completedAt,
      usageDurationMs: 1200,
      costInCents: 20,
      baseCostInCents: 7,
    });

    expect(result.finishedAt).toBe(completedAt.toISOString());
    expect(result.startedAt).toBe(startedAt.toISOString());
    expect(result.hasFinished).toBe(true);
    expect(result.isCancellable).toBe(false);
  });

  it("falls back to updatedAt when a final run has no completedAt", () => {
    const updatedAt = new Date("2026-05-07T10:00:00.000Z");

    const result = mapRunToLiveFields({
      friendlyId: "run_789",
      status: "CRASHED",
      updatedAt,
      startedAt: null,
      lockedAt: null,
      completedAt: null,
      usageDurationMs: 0,
      costInCents: 0,
      baseCostInCents: 0,
    });

    expect(result.finishedAt).toBe(updatedAt.toISOString());
    expect(result.hasFinished).toBe(true);
    expect(result.isPending).toBe(false);
    expect(result.isCancellable).toBe(false);
  });
});
