/** An optional cap on how long ClickHouse may run a read, in whole seconds. */
export type ReadLimit = { maxExecutionSeconds: number };

/** Per-call query options carrying the cap, or nothing when there is no cap. */
export const readLimitOptions = (limit: ReadLimit | undefined) =>
  limit === undefined
    ? undefined
    : { params: { clickhouse_settings: { max_execution_time: limit.maxExecutionSeconds } } };
