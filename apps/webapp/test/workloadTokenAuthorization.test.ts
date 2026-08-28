import { describe, expect, it } from "vitest";
import {
  evaluateCreatedAtGate,
  runAgeBucket,
} from "~/v3/services/worker/workloadTokenAuthorization.server";

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

describe("runAgeBucket", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  const agoMs = (ms: number) => new Date(now.getTime() - ms);

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it.each([
    [agoMs(0), "lt_1h"],
    [agoMs(HOUR - 1), "lt_1h"],
    [agoMs(HOUR), "1h_1d"],
    [agoMs(DAY - 1), "1h_1d"],
    [agoMs(DAY), "1d_7d"],
    [agoMs(7 * DAY - 1), "1d_7d"],
    [agoMs(7 * DAY), "7d_30d"],
    [agoMs(30 * DAY - 1), "7d_30d"],
    [agoMs(30 * DAY), "gt_30d"],
    [agoMs(365 * DAY), "gt_30d"],
  ])("buckets %s as %s", (createdAt, expected) => {
    expect(runAgeBucket(createdAt, now)).toBe(expected);
  });

  it("puts a future createdAt in the youngest bucket rather than throwing", () => {
    expect(runAgeBucket(new Date(now.getTime() + DAY), now)).toBe("lt_1h");
  });
});
