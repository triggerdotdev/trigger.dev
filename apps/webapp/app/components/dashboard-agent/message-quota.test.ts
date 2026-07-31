import { describe, expect, it } from "vitest";
import { countUserMessages, FREE_PLAN_MESSAGE_LIMIT, resolveMessageQuota } from "./message-quota";

describe("resolveMessageQuota", () => {
  it("caps a Free plan at the limit", () => {
    expect(resolveMessageQuota({ isFreePlan: true, used: 0 })).toEqual({
      kind: "within",
      used: 0,
      limit: FREE_PLAN_MESSAGE_LIMIT,
      remaining: FREE_PLAN_MESSAGE_LIMIT,
    });
    expect(
      resolveMessageQuota({ isFreePlan: true, used: FREE_PLAN_MESSAGE_LIMIT - 1 })
    ).toMatchObject({ kind: "within", remaining: 1 });
    expect(resolveMessageQuota({ isFreePlan: true, used: FREE_PLAN_MESSAGE_LIMIT })).toMatchObject({
      kind: "reached",
    });
  });

  it("never reports negative remaining once past the limit", () => {
    expect(resolveMessageQuota({ isFreePlan: true, used: 999 })).toEqual({
      kind: "reached",
      used: 999,
      limit: FREE_PLAN_MESSAGE_LIMIT,
    });
  });

  it("does not cap a paid plan", () => {
    expect(resolveMessageQuota({ isFreePlan: false, used: 999 })).toEqual({ kind: "unlimited" });
  });

  // The cap is a nudge, not a security boundary: a billing service that can't
  // answer must not be what stops someone using the product.
  it("fails open when the plan is unknown", () => {
    expect(resolveMessageQuota({ isFreePlan: undefined, used: 999 })).toEqual({
      kind: "unlimited",
    });
  });

  it("fails open when the count hasn't arrived", () => {
    expect(resolveMessageQuota({ isFreePlan: true, used: undefined })).toEqual({
      kind: "unlimited",
    });
  });
});

describe("countUserMessages", () => {
  it("counts only what the user sent", () => {
    expect(
      countUserMessages([
        { role: "user" },
        { role: "assistant" },
        { role: "user" },
        { role: "system" },
      ])
    ).toBe(2);
    expect(countUserMessages([])).toBe(0);
  });
});
