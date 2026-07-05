import invariant from "tiny-invariant";
import { env } from "~/env.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { singleton } from "~/utils/singleton";
import { isSplitEnabled } from "~/v3/runOpsMigration/splitMode.server";
import { meter, provider } from "~/v3/tracer.server";
import {
  setRunsReplicationConfiguredSources,
  setRunsReplicationGlobal,
} from "./runsReplicationGlobal.server";
import {
  RunsReplicationService,
  type RunsReplicationSource,
} from "./runsReplicationService.server";
import { signalsEmitter } from "./signals.server";

export const runsReplicationInstance = singleton(
  "runsReplicationInstance",
  initializeRunsReplicationInstance
);

export function buildReplicationSources(args: {
  splitEnabled: boolean;
  legacyUrl: string;
  newUrl?: string;
  /** `false` forces the new source off under split; undefined follows split. */
  newSourceOverride?: boolean;
  legacySlotName: string;
  legacyPublicationName: string;
  legacyOriginGeneration: number;
  newSlotName: string;
  newPublicationName: string;
  newOriginGeneration: number;
}): RunsReplicationSource[] {
  const legacy: RunsReplicationSource = {
    id: "legacy",
    pgConnectionUrl: args.legacyUrl,
    slotName: args.legacySlotName,
    publicationName: args.legacyPublicationName,
    originGeneration: args.legacyOriginGeneration,
  };

  const newSourceOn = args.splitEnabled && !!args.newUrl && args.newSourceOverride !== false;

  if (!newSourceOn || !args.newUrl) {
    return [legacy];
  }

  const next: RunsReplicationSource = {
    id: "new",
    pgConnectionUrl: args.newUrl,
    slotName: args.newSlotName,
    publicationName: args.newPublicationName,
    originGeneration: args.newOriginGeneration,
  };

  return [legacy, next];
}

/**
 * The residency-split gate and the `#new`->ClickHouse replication gate are
 * independent env vars. If split is on (run-ops runs are minted on the new DB) but the
 * constructed sources[] has no `"new"` source, every run-ops run is silently missing from
 * ClickHouse — under-counting all CH-fronted usage/cost/metrics aggregates with no
 * Postgres fallback. Couple the gates at boot: this misconfiguration must fail loudly
 * rather than ship a fleet-wide under-count.
 */
export class SplitReplicationMisconfiguredError extends Error {
  constructor() {
    super(
      'RUN_OPS_SPLIT_ENABLED is on but the runs-replication sources[] has no "new" source: ' +
        "run-ops runs on the new DB would not replicate to ClickHouse, under-counting every " +
        "ClickHouse-fronted aggregate. Enable the new replication source " +
        "(RUN_REPLICATION_NEW_ENABLED / RUN_REPLICATION_RUN_OPS_DATABASE_URL) or turn the split off."
    );
    this.name = "SplitReplicationMisconfiguredError";
  }
}

export function assertReplicationCoversSplit(args: {
  splitEnabled: boolean;
  sources: RunsReplicationSource[];
}): void {
  if (args.splitEnabled && !args.sources.some((s) => s.id === "new")) {
    throw new SplitReplicationMisconfiguredError();
  }
}

function initializeRunsReplicationInstance() {
  const { DATABASE_URL } = process.env;
  invariant(typeof DATABASE_URL === "string", "DATABASE_URL env var not set");

  if (!env.RUN_REPLICATION_CLICKHOUSE_URL) {
    console.log("🗃️  Runs replication service not enabled");
    return;
  }

  console.log("🗃️  Runs replication service enabled");

  // Shared options for both the legacy-only and the multi-source constructions.
  // Excludes per-source identity (pgConnectionUrl/slotName/publicationName/sources).
  const baseReplicationOptions = {
    clickhouseFactory,
    serviceName: "runs-replication",
    redisOptions: {
      keyPrefix: "runs-replication:",
      port: env.RUN_REPLICATION_REDIS_PORT ?? undefined,
      host: env.RUN_REPLICATION_REDIS_HOST ?? undefined,
      username: env.RUN_REPLICATION_REDIS_USERNAME ?? undefined,
      password: env.RUN_REPLICATION_REDIS_PASSWORD ?? undefined,
      enableAutoPipelining: true,
      ...(env.RUN_REPLICATION_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    maxFlushConcurrency: env.RUN_REPLICATION_MAX_FLUSH_CONCURRENCY,
    flushIntervalMs: env.RUN_REPLICATION_FLUSH_INTERVAL_MS,
    flushBatchSize: env.RUN_REPLICATION_FLUSH_BATCH_SIZE,
    leaderLockTimeoutMs: env.RUN_REPLICATION_LEADER_LOCK_TIMEOUT_MS,
    leaderLockExtendIntervalMs: env.RUN_REPLICATION_LEADER_LOCK_EXTEND_INTERVAL_MS,
    leaderLockAcquireAdditionalTimeMs: env.RUN_REPLICATION_LEADER_LOCK_ADDITIONAL_TIME_MS,
    leaderLockRetryIntervalMs: env.RUN_REPLICATION_LEADER_LOCK_RETRY_INTERVAL_MS,
    ackIntervalSeconds: env.RUN_REPLICATION_ACK_INTERVAL_SECONDS,
    logLevel: env.RUN_REPLICATION_LOG_LEVEL,
    waitForAsyncInsert: env.RUN_REPLICATION_WAIT_FOR_ASYNC_INSERT === "1",
    tracer: provider.getTracer("runs-replication-service"),
    meter,
    insertMaxRetries: env.RUN_REPLICATION_INSERT_MAX_RETRIES,
    insertBaseDelayMs: env.RUN_REPLICATION_INSERT_BASE_DELAY_MS,
    insertMaxDelayMs: env.RUN_REPLICATION_INSERT_MAX_DELAY_MS,
    insertStrategy: env.RUN_REPLICATION_INSERT_STRATEGY,
    disablePayloadInsert: env.RUN_REPLICATION_DISABLE_PAYLOAD_INSERT === "1",
    disableErrorFingerprinting: env.RUN_REPLICATION_DISABLE_ERROR_FINGERPRINTING === "1",
  };

  // Construct the SINGLE legacy source synchronously (the split gate has not resolved
  // yet at module-init time, and singleton(...) memoizes this synchronous return value).
  let service = new RunsReplicationService({
    ...baseReplicationOptions,
    pgConnectionUrl: DATABASE_URL,
    slotName: env.RUN_REPLICATION_SLOT_NAME,
    publicationName: env.RUN_REPLICATION_PUBLICATION_NAME,
    // Explicit legacy source so the leader-lock key matches the id the status
    // route probes from the registry below.
    sources: [
      {
        id: "legacy",
        pgConnectionUrl: DATABASE_URL,
        slotName: env.RUN_REPLICATION_SLOT_NAME,
        publicationName: env.RUN_REPLICATION_PUBLICATION_NAME,
        originGeneration: env.RUN_REPLICATION_LEGACY_ORIGIN_GENERATION,
      },
    ],
  });

  // Register the live handle so the status route + lifecycle routes can find it.
  setRunsReplicationGlobal(service);
  setRunsReplicationConfiguredSources([
    {
      id: "legacy",
      slotName: env.RUN_REPLICATION_SLOT_NAME,
      originGeneration: env.RUN_REPLICATION_LEGACY_ORIGIN_GENERATION,
    },
  ]);

  if (env.RUN_REPLICATION_ENABLED === "1") {
    // Construct-after-gate: resolve the async split gate ONCE at boot, and
    // when both sources are enabled rebuild `service` with sources[] before starting.
    // The legacy-only instance above is never started in the dual path (no slot/lock
    // taken). runsReplicationService.server.ts is untouched. The create route also calls
    // setRunsReplicationGlobal — last-writer-wins is the existing contract.
    isSplitEnabled()
      .then(async (splitEnabled) => {
        const sources = buildReplicationSources({
          splitEnabled,
          legacyUrl: DATABASE_URL,
          newUrl: env.RUN_REPLICATION_RUN_OPS_DATABASE_URL,
          newSourceOverride: env.RUN_REPLICATION_NEW_ENABLED === "disabled" ? false : undefined,
          legacySlotName: env.RUN_REPLICATION_SLOT_NAME,
          legacyPublicationName: env.RUN_REPLICATION_PUBLICATION_NAME,
          legacyOriginGeneration: env.RUN_REPLICATION_LEGACY_ORIGIN_GENERATION,
          newSlotName: env.RUN_REPLICATION_NEW_SLOT_NAME,
          newPublicationName: env.RUN_REPLICATION_NEW_PUBLICATION_NAME,
          newOriginGeneration: env.RUN_REPLICATION_NEW_ORIGIN_GENERATION,
        });

        // Refuse to start replication if split is on but `#new` is not a source.
        assertReplicationCoversSplit({ splitEnabled, sources });

        if (sources.length > 1) {
          // Release the bootstrap instance's eager replication client (Redis + Redlock)
          // before replacing it, or it leaks for the process lifetime. shutdown() is idempotent.
          await service.shutdown();
          // The scalar pgConnectionUrl/slotName/publicationName remain required on the
          // options type, but are ignored when sources[] is non-empty — the
          // service normalizes off sources. Pass the legacy scalars to satisfy the type.
          service = new RunsReplicationService({
            ...baseReplicationOptions,
            pgConnectionUrl: DATABASE_URL,
            slotName: env.RUN_REPLICATION_SLOT_NAME,
            publicationName: env.RUN_REPLICATION_PUBLICATION_NAME,
            sources,
          });
          setRunsReplicationGlobal(service);
          setRunsReplicationConfiguredSources(
            sources.map((s) => ({
              id: s.id,
              slotName: s.slotName,
              originGeneration: s.originGeneration,
            }))
          );
        }

        return clickhouseFactory.isReady().then(() => service.start());
      })
      .then(() => console.log("🗃️ Runs replication service started"))
      .catch((error) => {
        if (error instanceof SplitReplicationMisconfiguredError) {
          // A silent ClickHouse under-count is worse than a crash — make it fatal.
          console.error("🚨 FATAL: run-ops split / ClickHouse replication misconfiguration", {
            error,
          });
          process.exit(1);
        }
        console.error("🗃️ Runs replication service failed to start", { error });
      });

    // Closures over the `let` so SIGTERM/SIGINT hit whichever instance is live (NOT a
    // stale .bind() to the discarded legacy-only instance).
    signalsEmitter.on("SIGTERM", () => service.shutdown());
    signalsEmitter.on("SIGINT", () => service.shutdown());
  }

  // Returns the legacy-only instance synchronously (singleton memoizes this). Lifecycle
  // routes read getRunsReplicationGlobal() first, so they get the live multi-source one.
  return service;
}
