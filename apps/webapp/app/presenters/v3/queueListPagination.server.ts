export type QueueListFilteredPagination = {
  mode: "filtered";
  currentPage: number;
  hasMore: boolean;
};

export type QueueListUnfilteredPagination = {
  mode: "unfiltered";
  currentPage: number;
  totalPages: number;
  count: number;
};

export type QueueListPagination = QueueListFilteredPagination | QueueListUnfilteredPagination;

export type OffsetLimitPagination = {
  currentPage: number;
  totalPages: number;
  count: number;
};

/** Maps presenter pagination to the public API / SDK offset-limit contract. */
export function toOffsetLimitQueueListPagination(
  pagination: QueueListPagination,
  options: { itemsOnPage: number; perPage: number }
): OffsetLimitPagination {
  if (pagination.mode === "unfiltered") {
    return {
      currentPage: pagination.currentPage,
      totalPages: pagination.totalPages,
      count: pagination.count,
    };
  }

  return {
    currentPage: pagination.currentPage,
    totalPages: pagination.hasMore ? pagination.currentPage + 1 : pagination.currentPage,
    count:
      (pagination.currentPage - 1) * options.perPage +
      options.itemsOnPage +
      (pagination.hasMore ? 1 : 0),
  };
}
