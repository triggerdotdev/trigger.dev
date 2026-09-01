import { describe, expect, it } from "vitest";
import { cohortMetricLabel } from "~/v3/cohortMetricLabel.server";

describe("cohortMetricLabel", () => {
  it("returns the org id when it is a cohort member", () => {
    expect(cohortMetricLabel("org_123", (id) => id === "org_123")).toBe("org_123");
  });

  it("returns 'other' for a non-member org", () => {
    expect(cohortMetricLabel("org_999", (id) => id === "org_123")).toBe("other");
  });

  it("returns 'other' when the org id is undefined", () => {
    expect(cohortMetricLabel(undefined, () => true)).toBe("other");
  });

  it("collapses every org to 'other' with an always-false predicate", () => {
    for (const id of ["org_a", "org_b", "org_c"]) {
      expect(cohortMetricLabel(id, () => false)).toBe("other");
    }
  });
});
