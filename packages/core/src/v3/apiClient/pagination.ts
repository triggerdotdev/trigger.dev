export interface CursorPageParams {
  limit?: number;
  after?: string;
  before?: string;
}

export interface OffsetLimitPageParams {
  limit?: number;
  page?: number;
}

export interface PageResponse<Item> {
  data: Array<Item>;
}

export interface CursorPageResponse<Item> extends PageResponse<Item> {
  pagination: {
    next?: string;
    previous?: string;
  };
}

export interface OffsetLimitPageResponse<Item> extends PageResponse<Item> {
  pagination: {
    currentPage: number;
    totalPages: number;
    count: number;
  };
}

export interface Page<Item> {
  getPaginatedItems(): Item[];
  hasNextPage(): boolean;
  hasPreviousPage(): boolean;
}

export class CursorPage<Item> implements CursorPageResponse<Item>, Page<Item>, AsyncIterable<Item> {
  data: Array<Item>;
  pagination: { next?: string; previous?: string };

  constructor(
    data: Array<Item>,
    pagination: { next?: string; previous?: string },
    private pageFetcher: (params: Omit<CursorPageParams, "limit">) => Promise<CursorPage<Item>>
  ) {
    this.data = data;
    this.pagination = pagination;
  }

  getPaginatedItems(): Item[] {
    return this.data ?? [];
  }

  hasNextPage(): boolean {
    return !!this.pagination.next;
  }

  hasPreviousPage(): boolean {
    return !!this.pagination.previous;
  }

  getNextPage(): Promise<CursorPage<Item>> {
    if (!this.pagination.next) {
      throw new Error("No next page available");
    }

    return this.pageFetcher({ after: this.pagination.next });
  }

  getPreviousPage(): Promise<CursorPage<Item>> {
    if (!this.pagination.previous) {
      throw new Error("No previous page available");
    }

    return this.pageFetcher({ before: this.pagination.previous });
  }

  async *iterPages() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let page: CursorPage<Item> = this;
    yield page;
    while (page.hasNextPage()) {
      page = await page.getNextPage();
      yield page;
    }
  }

  async *[Symbol.asyncIterator]() {
    for await (const page of this.iterPages()) {
      for (const item of page.getPaginatedItems()) {
        yield item;
      }
    }
  }
}

export class OffsetLimitPage<Item>
  implements OffsetLimitPageResponse<Item>, Page<Item>, AsyncIterable<Item>
{
  data: Array<Item>;
  pagination: { currentPage: number; totalPages: number; count: number };

  constructor(
    data: Array<Item>,
    pagination: { currentPage: number; totalPages: number; count: number },
    private pageFetcher: (
      params: Omit<OffsetLimitPageParams, "limit">
    ) => Promise<OffsetLimitPage<Item>>
  ) {
    this.data = data;
    this.pagination = pagination;
  }

  getPaginatedItems(): Item[] {
    return this.data ?? [];
  }

  hasNextPage(): boolean {
    return this.pagination.currentPage < this.pagination.totalPages;
  }

  hasPreviousPage(): boolean {
    return this.pagination.currentPage > 1;
  }

  getNextPage(): Promise<OffsetLimitPage<Item>> {
    if (!this.hasNextPage()) {
      throw new Error("No next page available");
    }

    return this.pageFetcher({
      page: this.pagination.currentPage + 1,
    });
  }

  getPreviousPage(): Promise<OffsetLimitPage<Item>> {
    if (!this.hasPreviousPage()) {
      throw new Error("No previous page available");
    }

    return this.pageFetcher({
      page: this.pagination.currentPage - 1,
    });
  }

  async *iterPages() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let page: OffsetLimitPage<Item> = this;
    yield page;
    while (page.hasNextPage()) {
      page = await page.getNextPage();
      yield page;
    }
  }

  async *[Symbol.asyncIterator]() {
    for await (const page of this.iterPages()) {
      for (const item of page.getPaginatedItems()) {
        yield item;
      }
    }
  }
}
