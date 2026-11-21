import { describe, expect, it } from "vitest";
import { DeploymentListSearchParams } from "~/components/runs/v3/DeploymentFilters";

describe("DeploymentListSearchParams", () => {
  // Catches: a hand-edited ?day= turning the other filters off while their chips still show.
  it("ignores a day that isn't one and keeps the other filters", () => {
    for (const day of ["x", "2026-02-31", "0000-01-01", ""]) {
      const parsed = DeploymentListSearchParams.safeParse({
        statuses: ["FAILED"],
        branches: ["main"],
        search: "2026",
        day,
      });

      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({
        statuses: ["FAILED"],
        branches: ["main"],
        search: "2026",
        day: undefined,
      });
    }
  });

  it("keeps a real day", () => {
    expect(DeploymentListSearchParams.parse({ day: "2026-11-15" }).day).toBe("2026-11-15");
  });
});
