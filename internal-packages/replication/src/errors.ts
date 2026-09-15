export class LogicalReplicationClientError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * The publication a source subscribes through exists but does not carry the table we replicate —
 * commonly because it was created with no tables at all. Nothing throws and nothing stops: the
 * client retries and logs, while that source replicates NOTHING, so every ClickHouse-fronted
 * aggregate silently under-counts. Typed so a consumer can put a number on it and alarm.
 */
export class PublicationMisconfiguredError extends LogicalReplicationClientError {
  readonly publicationName: string;
  readonly table: string;

  constructor(message: string, options: { publicationName: string; table: string }) {
    super(message);
    this.name = "PublicationMisconfiguredError";
    this.publicationName = options.publicationName;
    this.table = options.table;
  }
}
