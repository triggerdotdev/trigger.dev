export interface CursorPageParams {
  limit?: number;
  after?: string;
  before?: string;
}

export interface CursorPageResponse<Item> {
  data: Array<Item>;
  pagination: {
    next?: string;
    previous?: string;
  };
}

export class CursorPage<Item> implements CursorPageResponse<Item>, AsyncIterable<Item> {
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
