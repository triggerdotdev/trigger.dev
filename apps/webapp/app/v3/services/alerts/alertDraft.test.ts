import { describe, expect, it } from "vitest";
import { FormSchema, buildCondition } from "./alertDraft";

function isoIn(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

const BASE = {
  capabilityKey: "queue.depth",
  scopeType: "all" as const,
  conditionKind: "occurrence" as const,
  notifierChannelIds: ["chan_1"],
};

describe("FormSchema expiresAt", () => {
  it("accepts no expiresAt", () => {
    expect(FormSchema.safeParse(BASE).success).toBe(true);
  });

  it("accepts a future date within the max window", () => {
    const result = FormSchema.safeParse({ ...BASE, expiresAt: isoIn(1) });
    expect(result.success).toBe(true);
  });

  it("rejects a whitespace-only expiresAt", () => {
    const result = FormSchema.safeParse({ ...BASE, expiresAt: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO expiresAt", () => {
    const result = FormSchema.safeParse({ ...BASE, expiresAt: "not-a-date" });
    expect(result.success).toBe(false);
  });

  it("rejects an expiresAt in the past", () => {
    const result = FormSchema.safeParse({ ...BASE, expiresAt: isoIn(-1) });
    expect(result.success).toBe(false);
  });

  it("accepts a far-future expiresAt", () => {
    const result = FormSchema.safeParse({ ...BASE, expiresAt: isoIn(365 * 2) });
    expect(result.success).toBe(true);
  });
});

describe("FormSchema notifiers", () => {
  it("rejects when no channel is selected", () => {
    const result = FormSchema.safeParse({ ...BASE, notifierChannelIds: [] });
    expect(result.success).toBe(false);
  });

  it("accepts one or more selected channels", () => {
    const result = FormSchema.safeParse({ ...BASE, notifierChannelIds: ["chan_1", "chan_2"] });
    expect(result.success).toBe(true);
  });
});

describe("FormSchema conditionParams", () => {
  const STATE_BASE = {
    capabilityKey: "health.composite",
    scopeType: "all" as const,
    conditionKind: "state" as const,
    notifierChannelIds: ["chan_1"],
  };

  it("accepts conditionParams on a state-kind form entry", () => {
    const result = FormSchema.safeParse({
      ...STATE_BASE,
      conditionParams: { cpuThreshold: 90, memoryThreshold: 85 },
    });
    expect(result.success).toBe(true);
  });

  it("manual form path forwards conditionParams via buildCondition", () => {
    const parsed = FormSchema.safeParse({
      ...STATE_BASE,
      conditionParams: { cpuThreshold: 90 },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const condition = buildCondition(parsed.data);
    expect(condition.kind).toBe("state");
    expect((condition as { params?: Record<string, number> }).params).toEqual({
      cpuThreshold: 90,
    });
  });

  it("omitting conditionParams leaves params undefined in the condition", () => {
    const parsed = FormSchema.safeParse(STATE_BASE);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const condition = buildCondition(parsed.data);
    expect((condition as { params?: Record<string, number> }).params).toBeUndefined();
  });
});
