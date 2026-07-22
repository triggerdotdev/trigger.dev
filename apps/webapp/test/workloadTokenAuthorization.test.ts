import { describe, expect, it } from "vitest";
import { evaluateCreatedAtGate } from "~/v3/services/worker/workloadTokenAuthorization.server";

const cutoff = new Date("2026-07-09T00:00:00.000Z");
const before = new Date("2026-07-01T00:00:00.000Z");
const after = new Date("2026-07-10T00:00:00.000Z");

describe("evaluateCreatedAtGate", () => {
  it("grandfathers a run created before the cutoff", () => {
    const result = evaluateCreatedAtGate({ runCreatedAt: before, cutoff });
    expect(result.outcome).toBe("grandfathered");
    expect(result.allow).toBe(true);
  });

  it("suppresses a run created after the cutoff", () => {
    const result = evaluateCreatedAtGate({ runCreatedAt: after, cutoff });
    expect(result.outcome).toBe("suppressed");
    expect(result.allow).toBe(false);
  });

  it("treats a run created exactly at the cutoff as grandfathered (not after)", () => {
    const result = evaluateCreatedAtGate({ runCreatedAt: cutoff, cutoff });
    expect(result.outcome).toBe("grandfathered");
    expect(result.allow).toBe(true);
  });
});
