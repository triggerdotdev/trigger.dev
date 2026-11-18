import { describe, expect, it } from "vitest";
import type { AuditLogContext, AuditLogInput } from "./auditLog.js";
import { resolveAuditEventAttribution } from "./auditLog.js";

const input = (overrides: Pick<AuditLogInput, "actor" | "source"> = {}): AuditLogInput => ({
  category: "members",
  action: "member.removed",
  organizationId: "org_1",
  target: { type: "member", id: "user_1", name: null },
  ...overrides,
});

const context = (overrides: Partial<AuditLogContext> = {}): AuditLogContext => ({
  occurredAt: new Date("2026-01-01T00:00:00Z"),
  actor: { type: "user", id: "user_2" },
  credential: null,
  onBehalfOf: null,
  source: "dashboard",
  endpoint: null,
  origin: null,
  requestId: null,
  ...overrides,
});

// The rule the audit log plugin applies before it stores an event; the webapp's in-memory test
// plugin applies the same function.
describe("resolveAuditEventAttribution", () => {
  // Catches: an event with no actor stored unattributed instead of dropped.
  it("drops an event with no actor", () => {
    expect(resolveAuditEventAttribution(input(), context({ actor: null }))).toEqual({
      dropped: "missing_actor",
    });
  });

  // Catches: an event with no source stored instead of dropped.
  it("drops an event with no source", () => {
    expect(resolveAuditEventAttribution(input(), context({ source: null }))).toEqual({
      dropped: "missing_source",
    });
  });

  // Catches: the order of the checks changing, so an event missing both is counted as the wrong reason.
  it("reports a missing actor before a missing source", () => {
    expect(resolveAuditEventAttribution(input(), context({ actor: null, source: null }))).toEqual({
      dropped: "missing_actor",
    });
  });

  // Catches: a call site's source hiding that staff made the request, which would show the staff
  // member's IP and user agent in the listing.
  it("keeps a staff context's source whatever the input says", () => {
    expect(
      resolveAuditEventAttribution(input({ source: "system" }), context({ source: "staff" }))
    ).toEqual({ actor: { type: "user", id: "user_2" }, source: "staff" });
  });

  // Catches: the input's source ignored, e.g. directory sync recorded as a dashboard change.
  it("lets the input's source override a non-staff context's", () => {
    expect(
      resolveAuditEventAttribution(input({ source: "system" }), context({ source: "dashboard" }))
    ).toEqual({ actor: { type: "user", id: "user_2" }, source: "system" });
  });

  // Catches: the input's actor ignored, e.g. a support session recorded as the staff user.
  it("lets the input's actor override the context's", () => {
    expect(
      resolveAuditEventAttribution(
        input({ actor: { type: "support", id: null } }),
        context({ actor: { type: "user", id: "user_2" } })
      )
    ).toEqual({ actor: { type: "support", id: null }, source: "dashboard" });
  });

  // Catches: the input's source alone not enough when the host knows no source.
  it("uses the input's source when the context has none", () => {
    expect(
      resolveAuditEventAttribution(input({ source: "system" }), context({ source: null }))
    ).toEqual({ actor: { type: "user", id: "user_2" }, source: "system" });
  });
});
