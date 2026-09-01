import invariant from "tiny-invariant";
import { env } from "~/env.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { singleton } from "~/utils/singleton";
import { isSplitEnabled } from "~/v3/runOpsMigration/splitMode.server";
import { nonAliasedShards } from "~/v3/runOpsShards.server";
import { meter, provider } from "~/v3/tracer.server";
import {
  setRunsReplicationConfiguredSources,
  setRunsReplicationGlobal,
} from "./runsReplicationGlobal.server";
import { runsReplicationSourceMetrics } from "./runsReplicationMetrics.server";
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
  /**
   * Gen-2 shards that own their own database, each with its own slot, publication and origin
   * generation. An aliased shard is absent: its target's slot already covers its WAL.
   */
  shards?: Array<{
    key: string;
    url: string;
    /** The DIRECT, non-pooled DSN. Logical replication needs a session-mode connection. */
    directUrl?: string;
    replication: { slotName: string; publicationName: string; originGeneration: number };
  }>;
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

  // Shard sources come after the gen-1 pair. Reached only when the new source is on, because
  // split is the precondition for a shard to exist at all. The origin generations come from the
  // descriptor, which the boot parser already bounds to 2..255 and checks for duplicates; the
  // service re-checks uniqueness across every source it is given.
  // The DIRECT dsn, not the app writer dsn. A transaction pooler cannot serve the replication
  // protocol, and the writer dsn is pooled in a real deployment. Gen-1 keeps the same separation
  // through its own RUN_REPLICATION_* variables, and the migration loop prefers directUrl too.
  const shardSources: RunsReplicationSource[] = (args.shards ?? []).map((shard) => ({
    id: shardSourceId(shard.key),
    pgConnectionUrl: shard.directUrl ?? shard.url,
    slotName: shard.replication.slotName,
    publicationName: shard.replication.publicationName,
    originGeneration: shard.replication.originGeneration,
  }));

  return [legacy, next, ...shardSources];
}

// The replication source id for a shard. It derives the per-source client name and the key the
// status route probes, so it must be stable and unique across sources. The leader lock is keyed on
// the slot name, not on this id.
function shardSourceId(key: string): string {
  return `shard-${key}`;
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
  constructor(message?: string) {
    super(
      message ??
        'RUN_OPS_SPLIT_ENABLED is on but the runs-replication sources[] has no "new" source: ' +
          "run-ops runs on the new DB would not replicate to ClickHouse, under-counting every " +
          "ClickHouse-fronted aggregate. Enable the new replication source " +
          "(RUN_REPLICATION_NEW_ENABLED / RUN_REPLICATION_RUN_OPS_DATABASE_URL) or turn the split off."
    );
    this.name = "SplitReplicationMisconfiguredError";
  }
}

/**
 * Two sources that share an identity. The descriptor parser checks uniqueness AMONG shards only, so
 * it cannot see the env-configured legacy and new sources: a shard can collide with either. The
 * service has its own check, but it throws from the constructor, which the caller reaches only AFTER
 * it has shut the bootstrap instance down — leaving the process up with NO replication at all, which
 * is the exact silent under-count this family of errors exists to prevent. So the check runs here,
 * at the fatal gate, before anything is torn down.
 */
class DuplicateReplicationIdentityError extends SplitReplicationMisconfiguredError {
  constructor(field: string, value: unknown) {
    super(
      `the runs-replication sources[] has two sources with the same ${field} "${String(value)}": ` +
        "two consumers on one WAL stream is a data race, and a shared origin generation defeats the " +
        "ClickHouse dedup tiebreak. Give every source its own slot, publication and origin generation."
    );
    this.name = "DuplicateReplicationIdentityError";
  }
}

/**
 * A configured shard with no replication source of its own. Subclasses the split error on purpose:
 * the boot catch site tests `instanceof SplitReplicationMisconfiguredError` to reach
 * process.exit(1), and a shard whose runs never reach ClickHouse must take that same exit.
 */
class ShardReplicationMisconfiguredError extends SplitReplicationMisconfiguredError {
  constructor(shardKey: string) {
    super(
      `run-ops shard ${shardKey} is configured but the runs-replication sources[] has no ` +
        `"${shardSourceId(shardKey)}" source: runs on that shard would not replicate to ` +
        "ClickHouse, under-counting every ClickHouse-fronted aggregate. Give the shard a " +
        "replication slot, publication and origin generation, or remove the shard."
    );
    this.name = "ShardReplicationMisconfiguredError";
  }
}

/**
 * A shard that replicates but declares no direct dsn. Falling back to its writer dsn is a silent
 * trap: if that dsn is pooled, the replication client throws inside start(), which is NOT a
 * SplitReplicationMisconfiguredError, so the process stays up with EVERY source down, legacy
 * included. Refuse the boot instead.
 */
class ShardDirectUrlMissingError extends SplitReplicationMisconfiguredError {
  constructor(shardKey: string) {
    super(
      `run-ops shard ${shardKey} declares replication but no directUrl: logical replication needs a ` +
        "session-mode connection, which a transaction pooler cannot serve. Give the shard a directUrl " +
        "pointing at its direct, non-pooled endpoint."
    );
    this.name = "ShardDirectUrlMissingError";
  }
}

export function assertReplicationCoversSplit(args: {
  splitEnabled: boolean;
  sources: RunsReplicationSource[];
  /** Every configured shard, aliased ones included. An aliased shard needs no source of its own. */
  shards?: Array<{ key: string; aliasOf?: "new"; hasDirectUrl?: boolean }>;
}): void {
  if (!args.splitEnabled) {
    return;
  }
  if (!args.sources.some((s) => s.id === "new")) {
    throw new SplitReplicationMisconfiguredError();
  }
  for (const shard of args.shards ?? []) {
    // An aliased shard shares its target's database, so the target's slot already carries its WAL.
    if (shard.aliasOf !== undefined) continue;
    if (!args.sources.some((s) => s.id === shardSourceId(shard.key))) {
      throw new ShardReplicationMisconfiguredError(shard.key);
    }
    if (shard.hasDirectUrl === false) {
      throw new ShardDirectUrlMissingError(shard.key);
    }
  }

  // Cross-source identity, over EVERY source and not only the shards. A correct two-source
  // deployment already satisfies this, because two consumers on one WAL slot is a data race that
  // cannot work. So this adds a loud failure for a configuration that was already broken silently.
  for (const field of ["id", "slotName", "publicationName", "originGeneration"] as const) {
    const seen = new Set<unknown>();
    for (const source of args.sources) {
      if (seen.has(source[field])) {
        throw new DuplicateReplicationIdentityError(field, source[field]);
      }
      seen.add(source[field]);
    }
  }
}

function initializeRunsReplicationInstance() {
  const { DATABASE_URL } = process.env;
  invariant(typeof DATABASE_URL === "string", "DATABASE_URL env var not set");

  // Legacy runs-replication source DSN; falls back to DATABASE_URL when its dedicated var is unset.
  const legacyDatabaseUrl = env.RUN_REPLICATION_LEGACY_DATABASE_URL ?? DATABASE_URL;

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
    maxPoisonStripsPerBatch: env.RUN_REPLICATION_MAX_POISON_STRIPS_PER_BATCH,
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
    // A source whose publication carries no usable table logs every 30s and replicates nothing.
    // Boot cannot see it (the source IS configured), so the counter is the alarmable signal.
    onSourceError: runsReplicationSourceMetrics.recordSourceError,
  };

  // Construct the SINGLE legacy source synchronously (the split gate has not resolved
  // yet at module-init time, and singleton(...) memoizes this synchronous return value).
  let service = new RunsReplicationService({
    ...baseReplicationOptions,
    pgConnectionUrl: legacyDatabaseUrl,
    slotName: env.RUN_REPLICATION_SLOT_NAME,
    publicationName: env.RUN_REPLICATION_PUBLICATION_NAME,
    // Explicit legacy source so the leader-lock key matches the id the status
    // route probes from the registry below.
    sources: [
      {
        id: "legacy",
        pgConnectionUrl: legacyDatabaseUrl,
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
    // An aliased shard replicates through its target's slot, so only the shards that own their own
    // database take a source. Coverage is then checked against EVERY descriptor, aliased included.
    // The schema requires `replication` on every non-aliased descriptor, so the guard below is a
    // type narrowing and not a policy.
    const shardReplicationByKey = new Map(
      env.RUN_OPS_SHARDS.flatMap((d) => (d.replication ? [[d.key, d.replication] as const] : []))
    );
    const shardsWithReplication = nonAliasedShards(env.RUN_OPS_SHARDS).flatMap((shard) => {
      const replication = shardReplicationByKey.get(shard.key);
      return replication
        ? [{ key: shard.key, url: shard.url, directUrl: shard.directUrl, replication }]
        : [];
    });

    isSplitEnabled()
      .then(async (splitEnabled) => {
        const sources = buildReplicationSources({
          splitEnabled,
          legacyUrl: legacyDatabaseUrl,
          newUrl: env.RUN_REPLICATION_RUN_OPS_DATABASE_URL,
          newSourceOverride: env.RUN_REPLICATION_NEW_ENABLED === "disabled" ? false : undefined,
          legacySlotName: env.RUN_REPLICATION_SLOT_NAME,
          legacyPublicationName: env.RUN_REPLICATION_PUBLICATION_NAME,
          legacyOriginGeneration: env.RUN_REPLICATION_LEGACY_ORIGIN_GENERATION,
          newSlotName: env.RUN_REPLICATION_NEW_SLOT_NAME,
          newPublicationName: env.RUN_REPLICATION_NEW_PUBLICATION_NAME,
          newOriginGeneration: env.RUN_REPLICATION_NEW_ORIGIN_GENERATION,
          shards: shardsWithReplication,
        });

        // Refuse to start replication if split is on but `#new` is not a source, or if any shard
        // that owns its own database has no source of its own.
        assertReplicationCoversSplit({
          splitEnabled,
          sources,
          shards: env.RUN_OPS_SHARDS.map((d) => ({
            key: d.key,
            aliasOf: d.aliasOf,
            hasDirectUrl: d.directUrl !== undefined,
          })),
        });

        if (sources.length > 1) {
          // Release the bootstrap instance's eager replication client (Redis + Redlock)
          // before replacing it, or it leaks for the process lifetime. shutdown() is idempotent.
          await service.shutdown();
          // The scalar pgConnectionUrl/slotName/publicationName remain required on the
          // options type, but are ignored when sources[] is non-empty — the
          // service normalizes off sources. Pass the legacy scalars to satisfy the type.
          service = new RunsReplicationService({
            ...baseReplicationOptions,
            pgConnectionUrl: legacyDatabaseUrl,
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
