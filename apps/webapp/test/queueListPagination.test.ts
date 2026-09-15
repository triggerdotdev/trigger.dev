import { describe, expect, it } from "vitest";
import { toOffsetLimitQueueListPagination } from "~/presenters/v3/queueListPagination.server";

describe("toOffsetLimitQueueListPagination", () => {
  it("passes through unfiltered pagination unchanged", () => {
    expect(
      toOffsetLimitQueueListPagination(
        { mode: "unfiltered", currentPage: 2, totalPages: 4, count: 80 },
        { itemsOnPage: 25, perPage: 25 }
      )
    ).toEqual({ currentPage: 2, totalPages: 4, count: 80 });
  });

  it("maps filtered pagination to the legacy offset-limit shape", () => {
    expect(
      toOffsetLimitQueueListPagination(
        { mode: "filtered", currentPage: 1, hasMore: true },
        { itemsOnPage: 25, perPage: 25 }
      )
    ).toEqual({ currentPage: 1, totalPages: 2, count: 26 });

    expect(
      toOffsetLimitQueueListPagination(
        { mode: "filtered", currentPage: 1, hasMore: false },
        { itemsOnPage: 10, perPage: 25 }
      )
    ).toEqual({ currentPage: 1, totalPages: 1, count: 10 });

    expect(
      toOffsetLimitQueueListPagination(
        { mode: "filtered", currentPage: 2, hasMore: false },
        { itemsOnPage: 5, perPage: 25 }
      )
    ).toEqual({ currentPage: 2, totalPages: 2, count: 30 });
  });
});
