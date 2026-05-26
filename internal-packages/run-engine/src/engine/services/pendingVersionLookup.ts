/**
 * Lookup interface for discovering TaskRun ids that are currently in the
 * `PENDING_VERSION` status for a given background-worker filter.
 *
 * The default Postgres-backed implementation lives in the webapp and is
 * injected via {@link SystemResources}. The run-engine package only owns
 * the contract; concrete implementations are provided by the consumer.
 *
 * Best-effort by design: implementations may return stale ids (rows that
 * have since transitioned) or omit recently-inserted rows (replication
 * lag against an analytical store). The caller MUST re-validate every
 * returned id against the source-of-truth database before mutating it.
 */
export type PendingVersionRunIdLookupOptions = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  taskIdentifiers: string[];
  queues: string[];
  /** Maximum number of ids to return. Implementations must respect this cap. */
  limit: number;
};

export type PendingVersionRunIdLookupResult = {
  runIds: string[];
};

export interface PendingVersionRunIdLookup {
  /** Stable identifier for logs and metrics, e.g. "clickhouse", "test-noop". */
  readonly name: string;

  lookupPendingVersionRunIds(
    options: PendingVersionRunIdLookupOptions
  ): Promise<PendingVersionRunIdLookupResult>;
}

/**
 * Default lookup used when nothing is wired up (tests that don't exercise
 * the lookup, or engine instances that don't run the pending-version
 * resolver). Returns an empty result so the system no-ops cleanly.
 */
export class NoopPendingVersionRunIdLookup implements PendingVersionRunIdLookup {
  readonly name = "noop";

  async lookupPendingVersionRunIds(): Promise<PendingVersionRunIdLookupResult> {
    return { runIds: [] };
  }
}
