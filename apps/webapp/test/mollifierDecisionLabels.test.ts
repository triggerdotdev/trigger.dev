import { describe, expect, it } from "vitest";

import { decisionLabels } from "~/v3/mollifier/mollifierTelemetry.server";

// The cardinality guard. `org` is a bounded label (enrolled cohort is capped
// at <= 10 orgs operationally), so it may ONLY be attached when the org is
// enrolled. Attaching it for non-enrolled orgs would fan `mollifier.decisions`
// out across every org id in production — the high-cardinality blow-up these
// labels are explicitly designed to avoid.
describe("decisionLabels", () => {
  it("always emits a bounded `enrolled` label (true/false)", () => {
    expect(decisionLabels("pass_through", { enrolled: false })).toEqual({
      outcome: "pass_through",
      enrolled: "false",
    });
    expect(decisionLabels("pass_through", { enrolled: true, orgId: "org_1" })).toMatchObject({
      enrolled: "true",
    });
  });

  it("attaches the `org` label ONLY when enrolled — never for non-enrolled, even if orgId is passed", () => {
    // Non-enrolled: orgId passed but MUST be dropped (cardinality guard).
    expect(decisionLabels("pass_through", { enrolled: false, orgId: "org_unbounded" })).toEqual({
      outcome: "pass_through",
      enrolled: "false",
    });

    // Enrolled: org label present.
    expect(
      decisionLabels("mollify", { enrolled: true, orgId: "org_1", reason: "per_env_rate" }),
    ).toEqual({
      outcome: "mollify",
      enrolled: "true",
      reason: "per_env_rate",
      org: "org_1",
    });
  });

  it("omits `org` when enrolled but no orgId is supplied", () => {
    expect(decisionLabels("pass_through", { enrolled: true })).toEqual({
      outcome: "pass_through",
      enrolled: "true",
    });
  });

  it("includes `reason` only when supplied", () => {
    expect(decisionLabels("pass_through", { enrolled: true, orgId: "org_1" })).not.toHaveProperty(
      "reason",
    );
    expect(
      decisionLabels("shadow_log", { enrolled: false, reason: "per_env_rate" }),
    ).toMatchObject({ reason: "per_env_rate" });
  });
});
