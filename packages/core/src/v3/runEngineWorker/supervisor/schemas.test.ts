import { describe, it, expect } from "vitest";
import { WorkerApiRunRestoreOutcomeRequestBody } from "./schemas.js";

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
