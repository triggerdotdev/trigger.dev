import { describe, expect, it } from "vitest";
import {
  countUserMessages,
  FREE_PLAN_MESSAGE_LIMIT,
  MESSAGE_QUOTA_REACHED_ERROR,
  messageQuotaReachedCopy,
  parseQuotaReachedResponse,
  resolveMessageQuota,
} from "./message-quota";

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

describe("parseQuotaReachedResponse", () => {
  it("maps a create/in 403 cap body to the limit", () => {
    // Both the create path and the `in` transport refuse with this exact body.
    expect(
      parseQuotaReachedResponse(403, { error: MESSAGE_QUOTA_REACHED_ERROR, limit: 20 })
    ).toEqual({ limit: 20 });
  });

  it("falls back to the free limit when the body omits it", () => {
    expect(parseQuotaReachedResponse(403, { error: MESSAGE_QUOTA_REACHED_ERROR })).toEqual({
      limit: FREE_PLAN_MESSAGE_LIMIT,
    });
  });

  it("ignores other errors and non-403 statuses so they surface normally", () => {
    expect(parseQuotaReachedResponse(403, { error: "something_else" })).toBeNull();
    expect(parseQuotaReachedResponse(500, { error: MESSAGE_QUOTA_REACHED_ERROR })).toBeNull();
    expect(parseQuotaReachedResponse(403, null)).toBeNull();
  });
});

describe("messageQuotaReachedCopy", () => {
  it("is a friendly sentence naming the limit, never the raw code", () => {
    const copy = messageQuotaReachedCopy(20);
    expect(copy).toContain("all 20 messages");
    expect(copy).toContain("Free plan");
    // Control break: if the mapping leaked the server code, this fails.
    expect(copy).not.toContain(MESSAGE_QUOTA_REACHED_ERROR);
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
