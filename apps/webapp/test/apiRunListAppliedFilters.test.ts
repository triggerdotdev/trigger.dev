import { describe, expect, it } from "vitest";
import { apiRunListAppliedCreatedAt } from "~/presenters/v3/apiRunListAppliedFilters";

describe("apiRunListAppliedCreatedAt", () => {
  // Catches: the runs list API silently listing only the last 7 days, with nothing in the
  // response saying a default period applied.
  it("reports the default period when no time filter is set", () => {
    expect(apiRunListAppliedCreatedAt({})).toEqual({
      period: "7d",
      from: undefined,
      to: undefined,
      isDefault: true,
    });
  });

  it("an explicit 7d period is not the default", () => {
    expect(apiRunListAppliedCreatedAt({ period: "7d" })).toMatchObject({
      period: "7d",
      isDefault: false,
    });
  });

  it("from and to replace the default period", () => {
    const from = Date.UTC(2026, 0, 1);
    const to = Date.UTC(2026, 0, 2);

    expect(apiRunListAppliedCreatedAt({ from, to })).toEqual({
      period: undefined,
      from: new Date(from),
      to: new Date(to),
      isDefault: false,
    });
  });

  it("from alone has no lower default", () => {
    const from = Date.UTC(2026, 0, 1);

    expect(apiRunListAppliedCreatedAt({ from })).toEqual({
      period: undefined,
      from: new Date(from),
      to: undefined,
      isDefault: false,
    });
  });
});
