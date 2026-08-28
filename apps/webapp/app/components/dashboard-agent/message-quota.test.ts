import { describe, expect, it } from "vitest";
import {
  countUserMessages,
  FREE_PLAN_MESSAGE_LIMIT,
  MESSAGE_QUOTA_REACHED_ERROR,
  messageQuotaReachedCopy,
  parseQuotaReachedResponse,
  quotaResponseUpdate,
  resolveMessageLimit,
  resolveMessageQuota,
  shouldClearCapReached,
} from "./message-quota";

describe("quotaResponseUpdate", () => {
  it("takes both fields from a coherent body", () => {
    expect(quotaResponseUpdate({ used: 30, limit: 50 })).toEqual({ used: 30, limit: 50 });
    expect(quotaResponseUpdate({ used: 30, limit: null })).toEqual({ used: 30, limit: null });
    expect(quotaResponseUpdate({ used: 0, limit: 0 })).toEqual({ used: 0, limit: 0 });
  });

  it("changes nothing on a degraded body", () => {
    // Control break: apply `{}` field-by-field and a good {used:30, limit:50} read decays to
    // used 30 against the client's 20 — "reached" against a cap the server never set.
    expect(quotaResponseUpdate({})).toBeNull();
    expect(quotaResponseUpdate(null)).toBeNull();
    expect(quotaResponseUpdate({ limit: 50 })).toBeNull();
  });
});

describe("resolveMessageLimit", () => {
  it("prefers a finite server-resolved limit over the client constant", () => {
    expect(resolveMessageLimit(5)).toBe(5);
    expect(resolveMessageLimit(0)).toBe(0);
    expect(resolveMessageLimit(500)).toBe(500);
  });

  it("keeps the free-plan nudge when the server has no finite limit", () => {
    // Pre-P0 the server limit is the unlimited sentinel and is sent as null: the client's
    // own 20 IS the nudge. Control break: thread the server number here and it disappears.
    expect(resolveMessageLimit(null)).toBe(FREE_PLAN_MESSAGE_LIMIT);
    expect(resolveMessageLimit(undefined)).toBe(FREE_PLAN_MESSAGE_LIMIT);
  });

  it("caps against the server limit once it is known", () => {
    expect(
      resolveMessageQuota({ isFreePlan: true, used: 5, limit: resolveMessageLimit(5) })
    ).toMatchObject({ kind: "reached", limit: 5 });
    expect(
      resolveMessageQuota({ isFreePlan: true, used: 5, limit: resolveMessageLimit(null) })
    ).toMatchObject({ kind: "within", limit: FREE_PLAN_MESSAGE_LIMIT, remaining: 15 });
  });
});

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
    ).toEqual({ limit: 20, planResolved: true });
  });

  it("falls back to the free limit when the body omits it", () => {
    expect(parseQuotaReachedResponse(403, { error: MESSAGE_QUOTA_REACHED_ERROR })).toEqual({
      limit: FREE_PLAN_MESSAGE_LIMIT,
      planResolved: false,
    });
  });

  it("ignores other errors and non-403 statuses so they surface normally", () => {
    expect(parseQuotaReachedResponse(403, { error: "something_else" })).toBeNull();
    expect(parseQuotaReachedResponse(500, { error: MESSAGE_QUOTA_REACHED_ERROR })).toBeNull();
    expect(parseQuotaReachedResponse(403, null)).toBeNull();
  });
});

describe("shouldClearCapReached", () => {
  const readQuota = (data: { used?: number; limit?: number | null } | null) => {
    const update = quotaResponseUpdate(data);
    return resolveMessageQuota({
      isFreePlan: true,
      used: update?.used,
      limit: resolveMessageLimit(update?.limit),
    });
  };

  it("releases the block once a read shows capacity", () => {
    // Refused at 20/20, then the allowance resets or the plan's cap grows.
    expect(shouldClearCapReached(readQuota({ used: 20, limit: 20 }))).toBe(false);
    expect(shouldClearCapReached(readQuota({ used: 0, limit: 20 }))).toBe(true);
    expect(shouldClearCapReached(readQuota({ used: 20, limit: 500 }))).toBe(true);
  });

  it("keeps the block when the read is degraded, so the composer can't flash", () => {
    expect(shouldClearCapReached(readQuota({ used: 20, limit: 20 }))).toBe(false);
    expect(shouldClearCapReached(readQuota(null))).toBe(false);
    expect(shouldClearCapReached(readQuota({ limit: 20 }))).toBe(false);
  });

  it("keeps the block while the plan hasn't resolved", () => {
    expect(shouldClearCapReached(resolveMessageQuota({ isFreePlan: undefined, used: 0 }))).toBe(
      false
    );
  });
});

describe("messageQuotaReachedCopy", () => {
  it("names the Free plan only for the client nudge", () => {
    const copy = messageQuotaReachedCopy(FREE_PLAN_MESSAGE_LIMIT, false);
    expect(copy).toContain(`all ${FREE_PLAN_MESSAGE_LIMIT} messages`);
    expect(copy).toContain("Free plan");
    // Control break: if the mapping leaked the server code, this fails.
    expect(copy).not.toContain(MESSAGE_QUOTA_REACHED_ERROR);
  });

  it("stays plan-agnostic for a server-resolved limit, which paying orgs also hit", () => {
    const copy = messageQuotaReachedCopy(500, true);
    expect(copy).toContain("all 500 messages");
    expect(copy).toContain("your plan");
    expect(copy).not.toContain("Free plan");
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
