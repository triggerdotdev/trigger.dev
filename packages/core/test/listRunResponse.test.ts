import { ListRunResponse } from "../src/v3/schemas/api.js";

describe("ListRunResponse appliedFilters", () => {
  // Catches: a server that predates appliedFilters failing the SDK's response parse.
  it("parses a response without appliedFilters", () => {
    const result = ListRunResponse.safeParse({ data: [], pagination: {} });

    expect(result.success).toBe(true);
    expect(result.data?.appliedFilters).toBeUndefined();
  });

  // Catches: the default 7-day window being dropped or its dates left as strings.
  it("parses the createdAt window the list used", () => {
    const result = ListRunResponse.safeParse({
      data: [],
      pagination: { next: "run_abc" },
      appliedFilters: {
        createdAt: {
          period: "7d",
          from: "2026-11-12T00:00:00.000Z",
          isDefault: true,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.data?.appliedFilters?.createdAt).toEqual({
      period: "7d",
      from: new Date("2026-11-12T00:00:00.000Z"),
      isDefault: true,
    });
  });

  // Catches: a newer server sending other filter keys breaking older parsers.
  it("ignores filter keys it does not know", () => {
    const result = ListRunResponse.safeParse({
      data: [],
      pagination: {},
      appliedFilters: { status: ["COMPLETED"] },
    });

    expect(result.success).toBe(true);
  });
});
