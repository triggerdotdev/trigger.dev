export type ConcurrencyLimitOptions = {
  id: string;
  limit: number;
};

export class ConcurrencyLimit {
  constructor(private options: ConcurrencyLimitOptions) {}

  get id() {
    return this.options.id;
  }

  get limit() {
    return this.options.limit;
  }
}
