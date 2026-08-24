import {
  Prisma,
  PrismaClient,
  boundedIn,
  $transaction as transac,
  type PrismaClientOrTransaction,
  type PrismaReplicaClient,
  type PrismaTransactionClient,
  type PrismaTransactionOptions,
  type WebhookDatabase,
  type WebhookReplicaDatabase,
} from "@trigger.dev/database";
import { RunOpsPrismaClient } from "@internal/run-ops-database";
import { markReadReplicaClient } from "@internal/run-store";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import invariant from "tiny-invariant";
import { env } from "./env.server";
import { logger } from "./services/logger.server";
import { isValidDatabaseUrl } from "./utils/db";
import { buildPrismaConnectionUrl } from "./utils/prismaConnectionUrl";
import {
  captureInfrastructureErrors,
  infraErrorAlreadyLogged,
  logTransactionInfrastructureError,
} from "./utils/prismaErrors";
import { singleton } from "./utils/singleton";
import { registerDatabaseMetricsSource } from "./utils/databaseMetrics.server";
import {
  isSplitEnabled,
  assertSplitRealtimeInterlock,
} from "./v3/runOpsMigration/splitMode.server";
import { computeRunOpsSplitReadEnabled } from "./v3/runOpsMigration/runOpsSplitReadGate";
import { resolveRunOpsPoolKnobs } from "./v3/runOpsPoolKnobs.server";
import { resolveShardResilience } from "./v3/transactionResilience.server";
import { assertControlPlaneCoresidencyAdvisory } from "./v3/runOpsMigration/controlPlaneCoresidencySentinel.server";
import { DATASOURCE_CONTEXT_KEY, startActiveSpan } from "./v3/tracer.server";
import {
  controlPlaneTransactionResilience,
  registerTransactionResilience,
  resilienceForClient,
  runOpsLegacyTransactionResilience,
  runOpsTransactionResilience,
} from "./v3/transactionResilience.server";
import type { Span } from "@opentelemetry/api";
import { context, trace } from "@opentelemetry/api";
import { queryPerformanceMonitor } from "./utils/queryPerformanceMonitor.server";

export type {
  PrismaTransactionClient,
  PrismaClientOrTransaction,
  PrismaTransactionOptions,
  PrismaReplicaClient,
  WebhookDatabase,
  WebhookReplicaDatabase,
};

// Boundary logger for transac(): skips an error the client extension already
// logged (and tagged) at the statement level, so a single failure is logged
// once. Shared by both $transaction overloads so the guard can't drift.
function logTransactionPrismaError(error: Prisma.PrismaClientKnownRequestError) {
  if (infraErrorAlreadyLogged(error)) {
    return;
  }
  logger.error("prisma.$transaction error", {
    code: error.code,
    meta: error.meta,
    stack: error.stack,
    message: error.message,
    name: error.name,
  });
}

function withTransactionDefaults(
  client: PrismaClientOrTransaction,
  options?: PrismaTransactionOptions
): PrismaTransactionOptions {
  const resilience = resilienceForClient(client as object);
  return {
    maxWait: resilience.maxWait,
    ...options,
    startRetry: options?.startRetry ?? resilience.startRetry,
  };
}

export async function $transaction<R>(
  prisma: PrismaClientOrTransaction,
  name: string,
  fn: (prisma: PrismaTransactionClient, span?: Span) => Promise<R>,
  options?: PrismaTransactionOptions
): Promise<R | undefined>;
export async function $transaction<R>(
  prisma: PrismaClientOrTransaction,
  fn: (prisma: PrismaTransactionClient) => Promise<R>,
  options?: PrismaTransactionOptions
): Promise<R | undefined>;
export async function $transaction<R>(
  prisma: PrismaClientOrTransaction,
  fnOrName: ((prisma: PrismaTransactionClient) => Promise<R>) | string,
  fnOrOptions?: ((prisma: PrismaTransactionClient) => Promise<R>) | PrismaTransactionOptions,
  options?: PrismaTransactionOptions
): Promise<R | undefined> {
  try {
    return await $transactionInner(prisma, fnOrName, fnOrOptions, options);
  } catch (error) {
    // transac()'s callback only logs coded Prisma errors; infra errors such as
    // PrismaClientInitializationError reach the boundary without a `.code`.
    logTransactionInfrastructureError(error);
    throw error;
  }
}

async function $transactionInner<R>(
  prisma: PrismaClientOrTransaction,
  fnOrName: ((prisma: PrismaTransactionClient) => Promise<R>) | string,
  fnOrOptions?: ((prisma: PrismaTransactionClient) => Promise<R>) | PrismaTransactionOptions,
  options?: PrismaTransactionOptions
): Promise<R | undefined> {
  if (typeof fnOrName === "string") {
    const effectiveOptions = withTransactionDefaults(prisma, options);
    return await startActiveSpan(fnOrName, async (span) => {
      span.setAttribute("$transaction", true);

      if (effectiveOptions.isolationLevel) {
        span.setAttribute("isolation_level", effectiveOptions.isolationLevel);
      }

      if (effectiveOptions.timeout) {
        span.setAttribute("timeout", effectiveOptions.timeout);
      }

      if (effectiveOptions.maxWait) {
        span.setAttribute("max_wait", effectiveOptions.maxWait);
      }

      if (effectiveOptions.swallowPrismaErrors) {
        span.setAttribute("swallow_prisma_errors", effectiveOptions.swallowPrismaErrors);
      }

      const fn = fnOrOptions as (prisma: PrismaTransactionClient, span: Span) => Promise<R>;

      return transac(
        prisma,
        (client) => fn(client, span),
        logTransactionPrismaError,
        effectiveOptions
      );
    });
  } else {
    return transac(
      prisma,
      fnOrName,
      logTransactionPrismaError,
      withTransactionDefaults(prisma, typeof fnOrOptions === "function" ? undefined : fnOrOptions)
    );
  }
}

export { Prisma, boundedIn };

type DatasourceLabel =
  | "control-plane-writer"
  | "control-plane-replica"
  | "legacy-run-ops-writer"
  | "legacy-run-ops-replica"
  | "run-ops-writer"
  | "run-ops-replica"
  | "webhook-writer"
  | "webhook-replica";

function tagDatasource<T extends PrismaClient>(datasource: DatasourceLabel, client: T): T {
  return client.$extends({
    name: "datasource-tagger",
    query: {
      $allOperations: ({ query, args }) => {
        trace.getActiveSpan()?.setAttribute("db.datasource", datasource);
        return context.with(
          context.active().setValue(DATASOURCE_CONTEXT_KEY, datasource),
          async () => await query(args)
        );
      },
    },
  }) as unknown as T;
}

// Same extension as tagDatasource but typed for RunOpsPrismaClient (different
// generated package — does not extend @trigger.dev/database.PrismaClient).
function tagDatasourceRunOps(
  datasource: DatasourceLabel,
  client: RunOpsPrismaClient
): RunOpsPrismaClient {
  return client.$extends({
    name: "datasource-tagger",
    query: {
      $allOperations: ({ query, args }) => {
        trace.getActiveSpan()?.setAttribute("db.datasource", datasource);
        return context.with(
          context.active().setValue(DATASOURCE_CONTEXT_KEY, datasource),
          async () => await query(args)
        );
      },
    },
  }) as unknown as RunOpsPrismaClient;
}

// Same wrapper as captureInfrastructureErrors, bridged via double cast because
// that helper is constrained to T extends @trigger.dev/database.PrismaClient.
function captureInfraErrorsRunOps(client: RunOpsPrismaClient): RunOpsPrismaClient {
  return captureInfrastructureErrors(
    client as unknown as PrismaClient
  ) as unknown as RunOpsPrismaClient;
}

export const prisma = singleton("prisma", () =>
  registerTransactionResilience(
    captureInfrastructureErrors(tagDatasource("control-plane-writer", getClient())),
    controlPlaneTransactionResilience
  )
);

export const $replica: PrismaReplicaClient = singleton("replica", () => {
  const replica = getReplicaClient();
  // Brand ONLY a real replica so the run-store routing layer keeps replica reads off the primary.
  // No replica configured → fall back to the writer `prisma`, which must stay UNBRANDED.
  return replica
    ? markReadReplicaClient(
        captureInfrastructureErrors(tagDatasource("control-plane-replica", replica))
      )
    : prisma;
});

/**
 * Webhook feature data-plane seam. The whole webhook feature (WebhookEndpoint + WebhookDelivery)
 * can run on a dedicated Postgres via WEBHOOK_DATABASE_URL; unset reuses the main prisma instance,
 * so single-DB installs open no extra pool.
 */
export const webhookPrisma: WebhookDatabase = singleton("webhookPrisma", () => {
  if (!env.WEBHOOK_DATABASE_URL) {
    return prisma;
  }
  return captureInfrastructureErrors(
    tagDatasource(
      "webhook-writer",
      buildWriterClient({
        url: env.WEBHOOK_DATABASE_URL,
        clientType: "webhook-writer",
        connectionLimit: env.WEBHOOK_DATABASE_CONNECTION_LIMIT ?? env.DATABASE_CONNECTION_LIMIT,
      })
    )
  );
});

/**
 * Webhook reader chain: an explicit webhook replica, else the webhook writer once split (no
 * separate replica yet), else the main $replica when the feature is not split.
 */
export const webhookReplica: WebhookReplicaDatabase = singleton("webhookReplica", () => {
  if (env.WEBHOOK_DATABASE_READ_REPLICA_URL) {
    return markReadReplicaClient(
      captureInfrastructureErrors(
        tagDatasource(
          "webhook-replica",
          buildReplicaClient({
            url: env.WEBHOOK_DATABASE_READ_REPLICA_URL,
            clientType: "webhook-reader",
            connectionLimit: env.WEBHOOK_DATABASE_CONNECTION_LIMIT ?? env.DATABASE_CONNECTION_LIMIT,
          })
        )
      )
    );
  }
  if (env.WEBHOOK_DATABASE_URL) {
    return webhookPrisma;
  }
  return $replica;
});

type RunOpsClients = { writer: PrismaClient; replica: PrismaReplicaClient };
type NewRunOpsClients = { writer: RunOpsPrismaClient; replica: RunOpsPrismaClient };
export type ShardTopologyDescriptor = {
  key: string;
  url?: string;
  replicaUrl?: string;
  aliasOf?: "new";
};
export type RunOpsTopology = {
  newRunOps: NewRunOpsClients;
  legacyRunOps: RunOpsClients;
  controlPlane: RunOpsClients;
  // One client pair per gen-2 shard descriptor. Empty unless RUN_OPS_SHARDS is configured. An
  // aliasOf:"new" descriptor maps to the newRunOps pair BY REFERENCE (no new pool).
  shards: Map<string, NewRunOpsClients>;
};
export type SelectRunOpsTopologyConfig = {
  splitEnabled: boolean;
  legacyUrl?: string;
  legacyReplicaUrl?: string;
  newUrl?: string;
  newReplicaUrl?: string;
  // When true, legacy reuses the control-plane client instead of opening its own pool. Defaults to false.
  legacySharesControlPlane?: boolean;
  shards?: ShardTopologyDescriptor[];
};
export type RunOpsClientBuilders = {
  controlPlane: RunOpsClients;
  buildNewWriter: (url: string, clientType: string) => RunOpsPrismaClient;
  buildNewReplica: (url: string, clientType: string) => RunOpsPrismaClient;
  // Legacy builders return the same PrismaClient/PrismaReplicaClient types as the control plane (no
  // RunOpsPrismaClient double-cast needed): the legacy DB carries the full control-plane schema.
  buildLegacyWriter: (url: string, clientType: string) => PrismaClient;
  buildLegacyReplica: (url: string, clientType: string) => PrismaReplicaClient;
  // Receive the whole descriptor so the singleton can resolve per-shard knobs and resilience by key.
  // Optional so the existing test literals (which build no shards) need no change.
  buildShardWriter?: (shard: ShardTopologyDescriptor) => RunOpsPrismaClient;
  buildShardReplica?: (shard: ShardTopologyDescriptor) => RunOpsPrismaClient;
};

// Pure run-ops client selector. No env, no isSplitEnabled() — those
// belong in the env-bound singleton (see runOpsTopology below). The builder
// callbacks are the only side-effecting boundary, so split-OFF (the default)
// calls NEITHER and opens no second connection.
export function selectRunOpsTopology(
  config: SelectRunOpsTopologyConfig,
  builders: RunOpsClientBuilders
): RunOpsTopology {
  const { controlPlane } = builders;

  const cpFallback: NewRunOpsClients = {
    writer: controlPlane.writer as unknown as RunOpsPrismaClient,
    replica: controlPlane.replica as unknown as RunOpsPrismaClient,
  };

  if (!config.splitEnabled) {
    return { newRunOps: cpFallback, legacyRunOps: controlPlane, controlPlane, shards: new Map() };
  }

  if (!config.legacyUrl || !config.newUrl) {
    return { newRunOps: cpFallback, legacyRunOps: controlPlane, controlPlane, shards: new Map() };
  }

  // Same-DB legacy reuses the control-plane pool; only build a separate pool once the DSNs diverge.
  let legacyRunOps: RunOpsClients;
  if (config.legacySharesControlPlane) {
    legacyRunOps = controlPlane;
  } else {
    const legacyWriter = builders.buildLegacyWriter(config.legacyUrl, "legacy-run-ops-writer");
    const legacyReplica: PrismaReplicaClient = config.legacyReplicaUrl
      ? builders.buildLegacyReplica(config.legacyReplicaUrl, "legacy-run-ops-replica")
      : legacyWriter;
    legacyRunOps = { writer: legacyWriter, replica: legacyReplica };
  }

  const newWriter = builders.buildNewWriter(config.newUrl, "run-ops-writer");
  const newReplica: RunOpsPrismaClient = config.newReplicaUrl
    ? builders.buildNewReplica(config.newReplicaUrl, "run-ops-replica")
    : newWriter;
  const newRunOps: NewRunOpsClients = { writer: newWriter, replica: newReplica };

  const shards = new Map<string, NewRunOpsClients>();
  for (const shard of config.shards ?? []) {
    if (shard.aliasOf === "new") {
      // Aliased: share the new store's clients by reference. No builder, no new pool — the soak path.
      shards.set(shard.key, newRunOps);
      continue;
    }
    if (!shard.url || !builders.buildShardWriter || !builders.buildShardReplica) {
      throw new Error(
        `selectRunOpsTopology: shard "${shard.key}" needs a url and shard builders when not aliased`
      );
    }
    const shardWriter = builders.buildShardWriter(shard);
    const shardReplica: RunOpsPrismaClient = shard.replicaUrl
      ? builders.buildShardReplica(shard)
      : shardWriter;
    shards.set(shard.key, { writer: shardWriter, replica: shardReplica });
  }

  return { newRunOps, legacyRunOps, controlPlane, shards };
}

// The env-bound run-ops topology singleton. The split decision uses
// a cheap synchronous env predicate (governs whether a second pool is opened);
// the async distinct-DB sentinel is enforced separately at boot via
// assertRunOpsSplitSentinel(). Because the builder callbacks only run when
// splitEnabled is true, single-DB reuses prisma/$replica by reference and opens
// nothing new. The builders apply the SAME wrapper pair the control-plane
// singletons use (captureInfrastructureErrors(tagDatasource(role, raw))).
const runOpsTopology: RunOpsTopology = singleton("runOpsTopology", () => {
  const newUrl = env.RUN_OPS_DATABASE_URL;
  // Gate on the opt-in flag too: the distinct-DB sentinel only runs when the flag is on.
  const splitEnabled = env.RUN_OPS_SPLIT_ENABLED && !!newUrl && !!env.RUN_OPS_LEGACY_DATABASE_URL;

  // Alias legacy onto the control-plane pool when both roles resolve to the same DB (replica URLs
  // fall back to their writer, matching how the clients themselves fall back).
  const cpWriterUrl = env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL;
  const cpReplicaUrl = env.CONTROL_PLANE_DATABASE_READ_REPLICA_URL ?? env.DATABASE_READ_REPLICA_URL;
  const legacySharesControlPlane =
    sameDatabaseTarget(env.RUN_OPS_LEGACY_DATABASE_URL, cpWriterUrl) &&
    sameDatabaseTarget(
      env.RUN_OPS_LEGACY_DATABASE_READ_REPLICA_URL ?? env.RUN_OPS_LEGACY_DATABASE_URL,
      cpReplicaUrl ?? cpWriterUrl
    );

  // Only meaningful for an independent legacy pool; a shared pool routes reads through $replica.
  if (splitEnabled && !legacySharesControlPlane && !env.RUN_OPS_LEGACY_DATABASE_READ_REPLICA_URL) {
    logger.warn(
      "RUN_OPS_LEGACY_DATABASE_READ_REPLICA_URL is unset while split is enabled; legacy reads will hit the legacy primary"
    );
  }

  const newPoolKnobs = resolveRunOpsPoolKnobs("new");
  const shardDescriptorsByKey = new Map(env.RUN_OPS_SHARDS.map((d) => [d.key, d]));

  return selectRunOpsTopology(
    {
      splitEnabled,
      legacyUrl: env.RUN_OPS_LEGACY_DATABASE_URL,
      legacyReplicaUrl: env.RUN_OPS_LEGACY_DATABASE_READ_REPLICA_URL,
      newUrl,
      newReplicaUrl: env.RUN_OPS_DATABASE_READ_REPLICA_URL,
      legacySharesControlPlane,
      shards: env.RUN_OPS_SHARDS.map((d) => ({
        key: d.key,
        url: d.url,
        replicaUrl: d.replicaUrl,
        aliasOf: d.aliasOf,
      })),
    },
    {
      controlPlane: { writer: prisma, replica: $replica },
      buildNewWriter: (url, clientType) =>
        registerTransactionResilience(
          captureInfraErrorsRunOps(
            tagDatasourceRunOps(
              "run-ops-writer",
              buildRunOpsClient({
                url,
                clientType,
                role: "writer",
                connectionLimit: newPoolKnobs.connectionLimit,
                poolTimeout: newPoolKnobs.writerPoolTimeout,
                connectTimeout: newPoolKnobs.writerConnectionTimeout,
                useDriverAdapter: newPoolKnobs.writerDriverAdapter,
              })
            )
          ),
          runOpsTransactionResilience
        ),
      // Brand the run-ops replica (only built for a real replica URL) so routed replica reads stay
      // off the primary. When no replica URL is set, selectRunOpsTopology reuses the writer here —
      // which this callback never touches, so the writer stays unbranded.
      buildNewReplica: (url, clientType) =>
        markReadReplicaClient(
          captureInfraErrorsRunOps(
            tagDatasourceRunOps(
              "run-ops-replica",
              buildRunOpsClient({
                url,
                clientType,
                role: "replica",
                connectionLimit: newPoolKnobs.replicaConnectionLimit,
                poolTimeout: newPoolKnobs.replicaPoolTimeout,
                connectTimeout: newPoolKnobs.replicaConnectionTimeout,
                useDriverAdapter: newPoolKnobs.replicaDriverAdapter,
              })
            )
          )
        ),
      // Legacy client shares the exact control-plane wrapper stack (the legacy DB carries the full
      // control-plane schema); markReadReplicaClient only on a real replica URL, as with the NEW replica.
      buildLegacyWriter: (url, clientType) =>
        registerTransactionResilience(
          captureInfrastructureErrors(
            tagDatasource(
              "legacy-run-ops-writer",
              buildWriterClient({
                url,
                clientType,
                poolTimeout: env.RUN_OPS_LEGACY_DATABASE_WRITER_POOL_TIMEOUT,
                connectTimeout: env.RUN_OPS_LEGACY_DATABASE_WRITER_CONNECTION_TIMEOUT,
                useDriverAdapter: env.RUN_OPS_LEGACY_DATABASE_WRITER_DRIVER_ADAPTER === "1",
              })
            )
          ),
          runOpsLegacyTransactionResilience
        ),
      buildLegacyReplica: (url, clientType) =>
        markReadReplicaClient(
          captureInfrastructureErrors(
            tagDatasource(
              "legacy-run-ops-replica",
              buildReplicaClient({
                url,
                clientType,
                poolTimeout: env.RUN_OPS_LEGACY_DATABASE_READ_REPLICA_POOL_TIMEOUT,
                connectTimeout: env.RUN_OPS_LEGACY_DATABASE_READ_REPLICA_CONNECTION_TIMEOUT,
                useDriverAdapter: env.RUN_OPS_LEGACY_DATABASE_REPLICA_DRIVER_ADAPTER === "1",
              })
            )
          )
        ),
      // A gen-2 shard is a dedicated run-ops DB, so it mirrors buildNewWriter/buildNewReplica: same
      // client class, same wrapper stack, its OWN resilience budget, and the "new"-role pool knobs
      // merged with the descriptor's per-shard overrides. Shards share the run-ops datasource tag.
      buildShardWriter: (shard) => {
        const descriptor = shardDescriptorsByKey.get(shard.key);
        const knobs = resolveRunOpsPoolKnobs("new", descriptor?.knobs);
        return registerTransactionResilience(
          captureInfraErrorsRunOps(
            tagDatasourceRunOps(
              "run-ops-writer",
              buildRunOpsClient({
                url: shard.url!,
                clientType: `run-ops-shard-${shard.key}-writer`,
                role: "writer",
                connectionLimit: knobs.connectionLimit,
                poolTimeout: knobs.writerPoolTimeout,
                connectTimeout: knobs.writerConnectionTimeout,
                useDriverAdapter: knobs.writerDriverAdapter,
              })
            )
          ),
          resolveShardResilience(shard.key, descriptor?.knobs)
        );
      },
      buildShardReplica: (shard) => {
        const descriptor = shardDescriptorsByKey.get(shard.key);
        const knobs = resolveRunOpsPoolKnobs("new", descriptor?.knobs);
        return markReadReplicaClient(
          captureInfraErrorsRunOps(
            tagDatasourceRunOps(
              "run-ops-replica",
              buildRunOpsClient({
                url: shard.replicaUrl!,
                clientType: `run-ops-shard-${shard.key}-replica`,
                role: "replica",
                connectionLimit: knobs.replicaConnectionLimit,
                poolTimeout: knobs.replicaPoolTimeout,
                connectTimeout: knobs.replicaConnectionTimeout,
                useDriverAdapter: knobs.replicaDriverAdapter,
              })
            )
          )
        );
      },
    }
  );
});

// Typed as RunOpsPrismaClient for the run-store boundary.
export const runOpsNewPrismaClient: RunOpsPrismaClient = runOpsTopology.newRunOps.writer;
export const runOpsNewReplicaClient: RunOpsPrismaClient = runOpsTopology.newRunOps.replica;
// Legacy-typed aliases kept for the remaining consumers that still expect PrismaClient /
// PrismaReplicaClient (idempotency residency, read-through, handlers, cascade cleanup).
export const runOpsNewPrisma: PrismaClient = runOpsTopology.newRunOps
  .writer as unknown as PrismaClient;
export const runOpsNewReplica: PrismaReplicaClient = runOpsTopology.newRunOps
  .replica as unknown as PrismaReplicaClient;
// Track 2: under split-on these point at the INDEPENDENT legacy client (its own DSN); under split-off
// or missing URLs they still alias the control-plane client, so single-DB installs are unchanged.
export const runOpsLegacyPrisma: PrismaClient = runOpsTopology.legacyRunOps.writer;
export const runOpsLegacyReplica: PrismaReplicaClient = runOpsTopology.legacyRunOps.replica;
// Branded legacy handles typed as RunOpsPrismaClient for the run-store boundary — same underlying
// legacy writer/replica as runOpsLegacyPrisma/runOpsLegacyReplica above, but carrying the run-ops
// brand so the guard classifies provably-legacy access as `runops`, not `cp`.
export const runOpsLegacyPrismaClient: RunOpsPrismaClient = runOpsTopology.legacyRunOps
  .writer as unknown as RunOpsPrismaClient;
export const runOpsLegacyReplicaClient: RunOpsPrismaClient = runOpsTopology.legacyRunOps
  .replica as unknown as RunOpsPrismaClient;

export const runOpsSplitReadEnabled: boolean = computeRunOpsSplitReadEnabled({
  newReplica: runOpsNewReplicaClient,
  controlPlaneWriter: prisma,
  controlPlaneReplica: $replica,
  hasNewUrl: !!env.RUN_OPS_DATABASE_URL,
  hasLegacyUrl: !!env.RUN_OPS_LEGACY_DATABASE_URL,
  logger,
});

// Boot-time interlock: if the flag is on but the distinct-DB sentinel does not
// confirm two physically-distinct run-ops DBs, refuse to enable split (data-loss
// interlock). Async, so it cannot live in the synchronous singleton factory — called
// fire-and-forget from the eager-boot path (routing is wired synchronously at module load).
export async function assertRunOpsSplitSentinel(): Promise<void> {
  if (!env.RUN_OPS_SPLIT_ENABLED) return;
  // Realtime interlock (synchronous): Electric replicates only from the control-plane
  // DB, so split-on without the native realtime backend leaves NEW-resident runs
  // invisible and hangs every subscription. Fail fast before the async DB probe.
  assertSplitRealtimeInterlock({
    splitEnabled: env.RUN_OPS_SPLIT_ENABLED,
    nativeRealtimeEnabled: env.REALTIME_BACKEND_NATIVE_ENABLED === "1",
  });
  const ok = await isSplitEnabled();
  if (!ok) {
    throw new Error(
      "RUN_OPS_SPLIT_ENABLED is on but the distinct-DB sentinel did not confirm two physically-distinct run-ops DBs; refusing to enable split (data-loss interlock)."
    );
  }
  // Advisory-only (T2.3): observe legacy vs control-plane co-residency. Emits a metric + log and only
  // throws when RUN_OPS_EXPECT_CONTROL_PLANE_SPLIT is on AND co-residency is positively confirmed.
  await assertControlPlaneCoresidencyAdvisory();
}

function getClient() {
  // Control-plane datasource repoint: prefer the dedicated control-plane DSN, falling back to
  // DATABASE_URL so self-host / single-DB installs boot byte-identical when CONTROL_PLANE_DATABASE_URL is unset.
  const url = env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL;
  invariant(typeof url === "string", "neither CONTROL_PLANE_DATABASE_URL nor DATABASE_URL is set");

  return buildWriterClient({
    url,
    clientType: "control-plane-writer",
    poolTimeout: env.DATABASE_WRITER_POOL_TIMEOUT,
    connectTimeout: env.DATABASE_WRITER_CONNECTION_TIMEOUT,
    useDriverAdapter: env.CONTROL_PLANE_DATABASE_WRITER_DRIVER_ADAPTER === "1",
  });
}

type DriverAdapterPool = {
  adapter: PrismaPg;
  pool: Pool;
  poolCounters: { opened: () => number; closed: () => number };
};

function buildDriverAdapterPool(
  connectionString: string,
  clientType: string,
  poolTimeoutSeconds: number,
  connectionLimit: number
): DriverAdapterPool {
  const pool = new Pool({
    connectionString,
    max: connectionLimit,
    connectionTimeoutMillis: poolTimeoutSeconds * 1000,
    application_name: env.SERVICE_NAME,
  });
  pool.on("error", (error) => {
    logger.error("prisma driver adapter pool error", {
      clientType,
      error: error instanceof Error ? error.message : String(error),
      ignoreError: true,
    });
  });

  let opened = 0;
  let closed = 0;
  pool.on("connect", () => {
    opened += 1;
  });
  pool.on("remove", () => {
    closed += 1;
  });

  let schema: string | undefined;
  try {
    schema = new URL(connectionString).searchParams.get("schema") ?? undefined;
  } catch {
    schema = undefined;
  }

  return {
    adapter: new PrismaPg(pool, { schema, disposeExternalPool: true }),
    pool,
    poolCounters: { opened: () => opened, closed: () => closed },
  };
}

// Generalized writer builder shared by the control-plane client and the run-ops
// clients. Returns a RAW, untagged, un-wrapped PrismaClient — the
// caller applies tagDatasource + captureInfrastructureErrors.
export function buildWriterClient({
  url,
  clientType,
  connectionLimit = env.DATABASE_CONNECTION_LIMIT,
  poolTimeout,
  connectTimeout,
  useDriverAdapter = false,
}: {
  url: string;
  clientType: string;
  connectionLimit?: number;
  poolTimeout?: number;
  connectTimeout?: number;
  useDriverAdapter?: boolean;
}): PrismaClient {
  const databaseUrl = buildPrismaConnectionUrl(url, {
    connectionLimit: connectionLimit.toString(),
    poolTimeout: (poolTimeout ?? env.DATABASE_POOL_TIMEOUT).toString(),
    connectTimeout: (connectTimeout ?? env.DATABASE_CONNECTION_TIMEOUT).toString(),
    applicationName: env.SERVICE_NAME,
  });

  console.log(
    `🔌 setting up prisma client to ${redactUrlSecrets(databaseUrl)}${
      useDriverAdapter ? " (pg driver adapter)" : ""
    }`
  );

  const logConfig = [
    // events
    {
      emit: "event",
      level: "error",
    },
    {
      emit: "event",
      level: "info",
    },
    {
      emit: "event",
      level: "warn",
    },
    // stdout
    ...((process.env.PRISMA_LOG_TO_STDOUT === "1"
      ? [
          {
            emit: "stdout",
            level: "error",
          },
          {
            emit: "stdout",
            level: "info",
          },
          {
            emit: "stdout",
            level: "warn",
          },
        ]
      : []) satisfies Prisma.LogDefinition[]),
    // Query performance monitoring
    ...((process.env.VERBOSE_PRISMA_LOGS === "1" ||
    process.env.VERY_SLOW_QUERY_THRESHOLD_MS !== undefined
      ? [
          {
            emit: "event",
            level: "query",
          },
        ]
      : []) satisfies Prisma.LogDefinition[]),
    // verbose
    ...((process.env.VERBOSE_PRISMA_LOGS === "1"
      ? [
          {
            emit: "stdout",
            level: "query",
          },
        ]
      : []) satisfies Prisma.LogDefinition[]),
  ] satisfies Prisma.LogDefinition[];

  const driverPool = useDriverAdapter
    ? buildDriverAdapterPool(
        url,
        clientType,
        poolTimeout ?? env.DATABASE_POOL_TIMEOUT,
        env.DATABASE_CONNECTION_LIMIT
      )
    : undefined;

  const client = driverPool
    ? new PrismaClient({ adapter: driverPool.adapter, log: logConfig })
    : new PrismaClient({
        datasources: { db: { url: databaseUrl.href } },
        log: logConfig,
      });

  registerDatabaseMetricsSource(
    driverPool
      ? {
          clientType,
          usesDriverAdapter: true,
          client,
          pool: driverPool.pool,
          poolCounters: driverPool.poolCounters,
        }
      : { clientType, usesDriverAdapter: false, client }
  );

  // Only use structured logging if we're not already logging to stdout
  if (process.env.PRISMA_LOG_TO_STDOUT !== "1") {
    client.$on("info", (log) => {
      logger.info("PrismaClient info", {
        clientType,
        event: {
          timestamp: log.timestamp,
          message: log.message,
          target: log.target,
        },
      });
    });

    client.$on("warn", (log) => {
      logger.warn("PrismaClient warn", {
        clientType,
        event: {
          timestamp: log.timestamp,
          message: log.message,
          target: log.target,
        },
      });
    });

    client.$on("error", (log) => {
      logger.error("PrismaClient error", {
        clientType,
        event: {
          timestamp: log.timestamp,
          message: log.message,
          target: log.target,
        },
        ignoreError: true,
      });
    });
  }

  // Add query performance monitoring
  client.$on("query", (log) => {
    queryPerformanceMonitor.onQuery("writer", log);
  });

  // Connect eagerly; Prisma will connect on use anyway.
  // Swallow the error when testing (DB likely unavailable)
  const connectPromise = client.$connect();
  if (env.NODE_ENV === "test") {
    connectPromise.catch((error) => {
      logger.warn("Failed to eagerly connect prisma client (writer)", { error });
    });
  }

  console.log(`🔌 prisma client connected`);

  return client;
}

function getReplicaClient() {
  // Control-plane replica repoint: prefer the dedicated control-plane replica, falling back to
  // DATABASE_READ_REPLICA_URL. Early-return undefined only when BOTH are unset, so $replica keeps
  // falling back to prisma exactly as today when no replica is configured.
  const url = env.CONTROL_PLANE_DATABASE_READ_REPLICA_URL ?? env.DATABASE_READ_REPLICA_URL;
  if (!url) {
    console.log(`🔌 No database replica, using the regular client`);
    return;
  }

  return buildReplicaClient({
    url,
    clientType: "control-plane-replica",
    poolTimeout: env.DATABASE_READ_REPLICA_POOL_TIMEOUT,
    connectTimeout: env.DATABASE_READ_REPLICA_CONNECTION_TIMEOUT,
    useDriverAdapter: env.CONTROL_PLANE_DATABASE_REPLICA_DRIVER_ADAPTER === "1",
  });
}

// Generalized replica builder shared by the control-plane replica and the run-ops
// replicas. Returns a RAW, untagged, un-wrapped PrismaClient — the
// caller applies tagDatasource + captureInfrastructureErrors.
export function buildReplicaClient({
  url,
  clientType,
  connectionLimit = env.DATABASE_CONNECTION_LIMIT,
  poolTimeout,
  connectTimeout,
  useDriverAdapter = false,
}: {
  url: string;
  clientType: string;
  connectionLimit?: number;
  poolTimeout?: number;
  connectTimeout?: number;
  useDriverAdapter?: boolean;
}): PrismaClient {
  const replicaUrl = buildPrismaConnectionUrl(url, {
    connectionLimit: connectionLimit.toString(),
    poolTimeout: (poolTimeout ?? env.DATABASE_POOL_TIMEOUT).toString(),
    connectTimeout: (connectTimeout ?? env.DATABASE_CONNECTION_TIMEOUT).toString(),
    applicationName: env.SERVICE_NAME,
  });

  console.log(
    `🔌 setting up read replica connection to ${redactUrlSecrets(replicaUrl)}${
      useDriverAdapter ? " (pg driver adapter)" : ""
    }`
  );

  const logConfig = [
    // events
    {
      emit: "event",
      level: "error",
    },
    {
      emit: "event",
      level: "info",
    },
    {
      emit: "event",
      level: "warn",
    },
    // stdout
    ...((process.env.PRISMA_LOG_TO_STDOUT === "1"
      ? [
          {
            emit: "stdout",
            level: "error",
          },
          {
            emit: "stdout",
            level: "info",
          },
          {
            emit: "stdout",
            level: "warn",
          },
        ]
      : []) satisfies Prisma.LogDefinition[]),
    // Query performance monitoring
    ...((process.env.VERBOSE_PRISMA_LOGS === "1" ||
    process.env.VERY_SLOW_QUERY_THRESHOLD_MS !== undefined
      ? [
          {
            emit: "event",
            level: "query",
          },
        ]
      : []) satisfies Prisma.LogDefinition[]),
    // verbose
    ...((process.env.VERBOSE_PRISMA_LOGS === "1"
      ? [
          {
            emit: "stdout",
            level: "query",
          },
        ]
      : []) satisfies Prisma.LogDefinition[]),
  ] satisfies Prisma.LogDefinition[];

  const driverPool = useDriverAdapter
    ? buildDriverAdapterPool(
        url,
        clientType,
        poolTimeout ?? env.DATABASE_POOL_TIMEOUT,
        env.DATABASE_CONNECTION_LIMIT
      )
    : undefined;

  const replicaClient = driverPool
    ? new PrismaClient({ adapter: driverPool.adapter, log: logConfig })
    : new PrismaClient({
        datasources: { db: { url: replicaUrl.href } },
        log: logConfig,
      });

  registerDatabaseMetricsSource(
    driverPool
      ? {
          clientType,
          usesDriverAdapter: true,
          client: replicaClient,
          pool: driverPool.pool,
          poolCounters: driverPool.poolCounters,
        }
      : { clientType, usesDriverAdapter: false, client: replicaClient }
  );

  // Only use structured logging if we're not already logging to stdout
  if (process.env.PRISMA_LOG_TO_STDOUT !== "1") {
    replicaClient.$on("info", (log) => {
      logger.info("PrismaClient info", {
        clientType,
        event: {
          timestamp: log.timestamp,
          message: log.message,
          target: log.target,
        },
      });
    });

    replicaClient.$on("warn", (log) => {
      logger.warn("PrismaClient warn", {
        clientType,
        event: {
          timestamp: log.timestamp,
          message: log.message,
          target: log.target,
        },
      });
    });

    replicaClient.$on("error", (log) => {
      logger.error("PrismaClient error", {
        clientType,
        event: {
          timestamp: log.timestamp,
          message: log.message,
          target: log.target,
        },
      });
    });
  }

  // Add query performance monitoring for replica client
  replicaClient.$on("query", (log) => {
    queryPerformanceMonitor.onQuery("replica", log);
  });

  // Connect eagerly; Prisma will connect on use anyway.
  // Swallow the error when testing (DB likely unavailable)
  const connectPromise = replicaClient.$connect();
  if (env.NODE_ENV === "test") {
    connectPromise.catch((error) => {
      logger.warn("Failed to eagerly connect prisma client (replica)", { error });
    });
  }

  console.log(`🔌 read replica connected`);

  return replicaClient;
}

// One factory for the run-ops writer and replica clients, backed by the dedicated RunOpsPrismaClient
// (a separately generated Prisma package). Parameterized by role and the resolved pool knobs, so a
// gen-1 new store and every gen-2 shard share this single builder. The control-plane builders
// (buildWriterClient/buildReplicaClient) are a DIFFERENT path and are untouched — this reuses only
// the shared low-level helpers (buildPrismaConnectionUrl, buildDriverAdapterPool).
function buildRunOpsClient({
  url,
  clientType,
  role,
  connectionLimit,
  poolTimeout,
  connectTimeout,
  useDriverAdapter = false,
}: {
  url: string;
  clientType: string;
  role: "writer" | "replica";
  connectionLimit: number;
  poolTimeout: number;
  connectTimeout: number;
  useDriverAdapter?: boolean;
}): RunOpsPrismaClient {
  const isWriter = role === "writer";
  const setupLabel = isWriter ? "run-ops prisma client" : "run-ops read replica connection";
  const connectedLabel = isWriter ? "run-ops prisma client connected" : "run-ops read replica connected";

  const connectionUrl = buildPrismaConnectionUrl(url, {
    connectionLimit: connectionLimit.toString(),
    poolTimeout: poolTimeout.toString(),
    connectTimeout: connectTimeout.toString(),
    applicationName: env.SERVICE_NAME,
  });

  console.log(
    `🔌 setting up ${setupLabel} to ${redactUrlSecrets(connectionUrl)}${
      useDriverAdapter ? " (pg driver adapter)" : ""
    }`
  );

  const log = [
    { emit: "event", level: "error" },
    { emit: "event", level: "info" },
    { emit: "event", level: "warn" },
    ...((process.env.VERBOSE_PRISMA_LOGS === "1" ||
    process.env.VERY_SLOW_QUERY_THRESHOLD_MS !== undefined
      ? [{ emit: "event", level: "query" }]
      : []) as { emit: "event"; level: "query" }[]),
  ] as const;

  const driverPool = useDriverAdapter
    ? buildDriverAdapterPool(url, clientType, poolTimeout, connectionLimit)
    : undefined;

  const client = driverPool
    ? new RunOpsPrismaClient({ adapter: driverPool.adapter, log: [...log] })
    : new RunOpsPrismaClient({ datasources: { db: { url: connectionUrl.href } }, log: [...log] });

  registerDatabaseMetricsSource(
    driverPool
      ? {
          clientType,
          usesDriverAdapter: true,
          client,
          pool: driverPool.pool,
          poolCounters: driverPool.poolCounters,
        }
      : { clientType, usesDriverAdapter: false, client }
  );

  if (process.env.PRISMA_LOG_TO_STDOUT !== "1") {
    client.$on("info", (log) => logger.info("RunOpsPrismaClient info", { clientType, event: log }));
    client.$on("warn", (log) => logger.warn("RunOpsPrismaClient warn", { clientType, event: log }));
    client.$on("error", (log) =>
      // The writer bridges P2002 -> 422 at the store boundary, so its infra errors are logged once
      // there (ignoreError). Replica errors are not on that write path, so they log normally.
      logger.error("RunOpsPrismaClient error", { clientType, event: log, ...(isWriter ? { ignoreError: true } : {}) })
    );
  }

  client.$on("query", (log) => queryPerformanceMonitor.onQuery(role, log));

  const connectPromise = client.$connect();
  if (env.NODE_ENV === "test") {
    connectPromise.catch((error) => {
      logger.warn(`Failed to eagerly connect run-ops prisma client (${role})`, { error });
    });
  }

  console.log(`🔌 ${connectedLabel}`);

  return client;
}

// True when two DSNs point at the same database (host/port/dbname/user), ignoring query params and
// password. Parse failure or a missing URL returns false, so an unrecognized DSN just isn't aliased.
export function sameDatabaseTarget(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const port = (u: URL) => u.port || "5432";
    return (
      ua.hostname.toLowerCase() === ub.hostname.toLowerCase() &&
      port(ua) === port(ub) &&
      ua.pathname === ub.pathname &&
      ua.username === ub.username
    );
  } catch {
    return false;
  }
}

function redactUrlSecrets(hrefOrUrl: string | URL) {
  const url = new URL(hrefOrUrl);
  url.password = "";
  return url.href;
}

export type { PrismaClient } from "@trigger.dev/database";

function getDatabaseSchema() {
  if (!isValidDatabaseUrl(env.DATABASE_URL)) {
    throw new Error("Invalid Database URL");
  }

  const databaseUrl = new URL(env.DATABASE_URL);
  const schemaFromSearchParam = databaseUrl.searchParams.get("schema");

  if (!schemaFromSearchParam) {
    console.debug("❗ database schema unspecified, will default to `public` schema");
    return "public";
  }

  return schemaFromSearchParam;
}

const DATABASE_SCHEMA = singleton("DATABASE_SCHEMA", getDatabaseSchema);

export const sqlDatabaseSchema = Prisma.sql([`${DATABASE_SCHEMA}`]);
