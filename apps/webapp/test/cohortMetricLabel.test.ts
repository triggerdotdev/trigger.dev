import { describe, expect, it } from "vitest";
import { cohortMetricLabel } from "~/v3/cohortMetricLabel.server";

describe("cohortMetricLabel", () => {
  it("returns the fixed 'cohort' label for a member, never the org id", () => {
    expect(cohortMetricLabel("org_123", (id) => id === "org_123")).toBe("cohort");
  });

  it("returns 'other' for a non-member org", () => {
    expect(cohortMetricLabel("org_999", (id) => id === "org_123")).toBe("other");
  });

  it("returns 'other' when the org id is undefined", () => {
    expect(cohortMetricLabel(undefined, () => true)).toBe("other");
  });

  it("emits at most two distinct labels regardless of how many orgs are members", () => {
    const labels = new Set<string>();
    for (const id of ["org_a", "org_b", "org_c", "org_d"]) {
      labels.add(cohortMetricLabel(id, () => true));
      labels.add(cohortMetricLabel(id, () => false));
    }
    expect([...labels].sort()).toEqual(["cohort", "other"]);
  });
});
