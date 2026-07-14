import {
  Prisma,
  PrismaClient,
  $transaction as transac,
  type PrismaClientOrTransaction,
  type PrismaReplicaClient,
  type PrismaTransactionClient,
  type PrismaTransactionOptions,
} from "@trigger.dev/database";
import { RunOpsPrismaClient } from "@internal/run-ops-database";
import { markReadReplicaClient } from "@internal/run-store";
import invariant from "tiny-invariant";
import { z } from "zod";
import { env } from "./env.server";
import { logger } from "./services/logger.server";
import { isValidDatabaseUrl } from "./utils/db";
import {
  captureInfrastructureErrors,
  infraErrorAlreadyLogged,
  logTransactionInfrastructureError,
} from "./utils/prismaErrors";
import { singleton } from "./utils/singleton";
import {
  isSplitEnabled,
  assertSplitRealtimeInterlock,
} from "./v3/runOpsMigration/splitMode.server";
import { computeRunOpsSplitReadEnabled } from "./v3/runOpsMigration/runOpsSplitReadGate";
import { assertControlPlaneCoresidencyAdvisory } from "./v3/runOpsMigration/controlPlaneCoresidencySentinel.server";
import { DATASOURCE_CONTEXT_KEY, startActiveSpan } from "./v3/tracer.server";
import type { Span } from "@opentelemetry/api";
import { context, trace } from "@opentelemetry/api";
import { queryPerformanceMonitor } from "./utils/queryPerformanceMonitor.server";

export type {
  PrismaTransactionClient,
  PrismaClientOrTransaction,
  PrismaTransactionOptions,
  PrismaReplicaClient,
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
    return await startActiveSpan(fnOrName, async (span) => {
      span.setAttribute("$transaction", true);

      if (options?.isolationLevel) {
        span.setAttribute("isolation_level", options.isolationLevel);
      }

      if (options?.timeout) {
        span.setAttribute("timeout", options.timeout);
      }

      if (options?.maxWait) {
        span.setAttribute("max_wait", options.maxWait);
      }

      if (options?.swallowPrismaErrors) {
        span.setAttribute("swallow_prisma_errors", options.swallowPrismaErrors);
      }

      const fn = fnOrOptions as (prisma: PrismaTransactionClient, span: Span) => Promise<R>;

      return transac(prisma, (client) => fn(client, span), logTransactionPrismaError, options);
    });
  } else {
    return transac(
      prisma,
      fnOrName,
      logTransactionPrismaError,
      typeof fnOrOptions === "function" ? undefined : fnOrOptions
    );
  }
}

export { Prisma };

function tagDatasource<T extends PrismaClient>(datasource: "writer" | "replica", client: T): T {
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
  datasource: "writer" | "replica",
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
  captureInfrastructureErrors(tagDatasource("writer", getClient()))
);

export const $replica: PrismaReplicaClient = singleton("replica", () => {
  const replica = getReplicaClient();
  // Brand ONLY a real replica so the run-store routing layer keeps replica reads off the primary.
  // No replica configured → fall back to the writer `prisma`, which must stay UNBRANDED.
  return replica
    ? markReadReplicaClient(captureInfrastructureErrors(tagDatasource("replica", replica)))
    : prisma;
});

export type RunOpsClients = { writer: PrismaClient; replica: PrismaReplicaClient };
export type NewRunOpsClients = { writer: RunOpsPrismaClient; replica: RunOpsPrismaClient };
export type RunOpsTopology = {
  newRunOps: NewRunOpsClients;
  legacyRunOps: RunOpsClients;
  controlPlane: RunOpsClients;
};
export type SelectRunOpsTopologyConfig = {
  splitEnabled: boolean;
  legacyUrl?: string;
  legacyReplicaUrl?: string;
  newUrl?: string;
  newReplicaUrl?: string;
  // When true, legacy reuses the control-plane client instead of opening its own pool. Defaults to false.
  legacySharesControlPlane?: boolean;
};
export type RunOpsClientBuilders = {
  controlPlane: RunOpsClients;
  buildNewWriter: (url: string, clientType: string) => RunOpsPrismaClient;
  buildNewReplica: (url: string, clientType: string) => RunOpsPrismaClient;
  // Legacy builders return the same PrismaClient/PrismaReplicaClient types as the control plane (no
  // RunOpsPrismaClient double-cast needed): the legacy DB carries the full control-plane schema.
  buildLegacyWriter: (url: string, clientType: string) => PrismaClient;
  buildLegacyReplica: (url: string, clientType: string) => PrismaReplicaClient;
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
    return { newRunOps: cpFallback, legacyRunOps: controlPlane, controlPlane };
  }

  if (!config.legacyUrl || !config.newUrl) {
    return { newRunOps: cpFallback, legacyRunOps: controlPlane, controlPlane };
  }

  // Same-DB legacy reuses the control-plane pool; only build a separate pool once the DSNs diverge.
  let legacyRunOps: RunOpsClients;
  if (config.legacySharesControlPlane) {
    legacyRunOps = controlPlane;
  } else {
    const legacyWriter = builders.buildLegacyWriter(config.legacyUrl, "run-ops-legacy-writer");
    const legacyReplica: PrismaReplicaClient = config.legacyReplicaUrl
      ? builders.buildLegacyReplica(config.legacyReplicaUrl, "run-ops-legacy-reader")
      : legacyWriter;
    legacyRunOps = { writer: legacyWriter, replica: legacyReplica };
  }

  const newWriter = builders.buildNewWriter(config.newUrl, "run-ops-new-writer");
  const newReplica: RunOpsPrismaClient = config.newReplicaUrl
    ? builders.buildNewReplica(config.newReplicaUrl, "run-ops-new-reader")
    : newWriter;

  return {
    newRunOps: { writer: newWriter, replica: newReplica },
    legacyRunOps,
    controlPlane,
  };
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

  return selectRunOpsTopology(
    {
      splitEnabled,
      legacyUrl: env.RUN_OPS_LEGACY_DATABASE_URL,
      legacyReplicaUrl: env.RUN_OPS_LEGACY_DATABASE_READ_REPLICA_URL,
      newUrl,
      newReplicaUrl: env.RUN_OPS_DATABASE_READ_REPLICA_URL,
      legacySharesControlPlane,
    },
    {
      controlPlane: { writer: prisma, replica: $replica },
      buildNewWriter: (url, clientType) =>
        captureInfraErrorsRunOps(
          tagDatasourceRunOps("writer", buildRunOpsWriterClient({ url, clientType }))
        ),
      // Brand the run-ops replica (only built for a real replica URL) so routed replica reads stay
      // off the primary. When no replica URL is set, selectRunOpsTopology reuses the writer here —
      // which this callback never touches, so the writer stays unbranded.
      buildNewReplica: (url, clientType) =>
        markReadReplicaClient(
          captureInfraErrorsRunOps(
            tagDatasourceRunOps("replica", buildRunOpsReplicaClient({ url, clientType }))
          )
        ),
      // Legacy client shares the exact control-plane wrapper stack (the legacy DB carries the full
      // control-plane schema); markReadReplicaClient only on a real replica URL, as with the NEW replica.
      buildLegacyWriter: (url, clientType) =>
        captureInfrastructureErrors(
          tagDatasource("writer", buildWriterClient({ url, clientType }))
        ),
      buildLegacyReplica: (url, clientType) =>
        markReadReplicaClient(
          captureInfrastructureErrors(
            tagDatasource("replica", buildReplicaClient({ url, clientType }))
          )
        ),
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

  return buildWriterClient({ url, clientType: "writer" });
}

// Generalized writer builder shared by the control-plane client and the run-ops
// clients. Returns a RAW, untagged, un-wrapped PrismaClient — the
// caller applies tagDatasource + captureInfrastructureErrors.
export function buildWriterClient({
  url,
  clientType,
}: {
  url: string;
  clientType: string;
}): PrismaClient {
  const databaseUrl = extendQueryParams(url, {
    connection_limit: env.DATABASE_CONNECTION_LIMIT.toString(),
    pool_timeout: env.DATABASE_POOL_TIMEOUT.toString(),
    connection_timeout: env.DATABASE_CONNECTION_TIMEOUT.toString(),
    application_name: env.SERVICE_NAME,
  });

  console.log(`🔌 setting up prisma client to ${redactUrlSecrets(databaseUrl)}`);

  const client = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl.href,
      },
    },
    log: [
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
    ],
  });

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

  return buildReplicaClient({ url, clientType: "reader" });
}

// Generalized replica builder shared by the control-plane replica and the run-ops
// replicas. Returns a RAW, untagged, un-wrapped PrismaClient — the
// caller applies tagDatasource + captureInfrastructureErrors.
export function buildReplicaClient({
  url,
  clientType,
}: {
  url: string;
  clientType: string;
}): PrismaClient {
  const replicaUrl = extendQueryParams(url, {
    connection_limit: env.DATABASE_CONNECTION_LIMIT.toString(),
    pool_timeout: env.DATABASE_POOL_TIMEOUT.toString(),
    connection_timeout: env.DATABASE_CONNECTION_TIMEOUT.toString(),
    application_name: env.SERVICE_NAME,
  });

  console.log(`🔌 setting up read replica connection to ${redactUrlSecrets(replicaUrl)}`);

  const replicaClient = new PrismaClient({
    datasources: {
      db: {
        url: replicaUrl.href,
      },
    },
    log: [
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
    ],
  });

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

function buildRunOpsWriterClient({
  url,
  clientType,
}: {
  url: string;
  clientType: string;
}): RunOpsPrismaClient {
  const databaseUrl = extendQueryParams(url, {
    connection_limit: env.DATABASE_CONNECTION_LIMIT.toString(),
    pool_timeout: env.DATABASE_POOL_TIMEOUT.toString(),
    connection_timeout: env.DATABASE_CONNECTION_TIMEOUT.toString(),
    application_name: env.SERVICE_NAME,
  });

  console.log(`🔌 setting up run-ops prisma client to ${redactUrlSecrets(databaseUrl)}`);

  const client = new RunOpsPrismaClient({
    datasources: { db: { url: databaseUrl.href } },
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "info" },
      { emit: "event", level: "warn" },
      ...((process.env.VERBOSE_PRISMA_LOGS === "1" ||
      process.env.VERY_SLOW_QUERY_THRESHOLD_MS !== undefined
        ? [{ emit: "event", level: "query" }]
        : []) as { emit: "event"; level: "query" }[]),
    ],
  });

  if (process.env.PRISMA_LOG_TO_STDOUT !== "1") {
    client.$on("info", (log) => logger.info("RunOpsPrismaClient info", { clientType, event: log }));
    client.$on("warn", (log) => logger.warn("RunOpsPrismaClient warn", { clientType, event: log }));
    client.$on("error", (log) =>
      logger.error("RunOpsPrismaClient error", { clientType, event: log, ignoreError: true })
    );
  }

  client.$on("query", (log) => queryPerformanceMonitor.onQuery("writer", log));

  const connectPromise = client.$connect();
  if (env.NODE_ENV === "test") {
    connectPromise.catch((error) => {
      logger.warn("Failed to eagerly connect run-ops prisma client (writer)", { error });
    });
  }

  console.log(`🔌 run-ops prisma client connected`);

  return client;
}

function buildRunOpsReplicaClient({
  url,
  clientType,
}: {
  url: string;
  clientType: string;
}): RunOpsPrismaClient {
  const replicaUrl = extendQueryParams(url, {
    // The new run-ops replica connects unpooled, so allow capping it independently of the writer.
    connection_limit: (
      env.RUN_OPS_DATABASE_READ_REPLICA_CONNECTION_LIMIT ?? env.DATABASE_CONNECTION_LIMIT
    ).toString(),
    pool_timeout: env.DATABASE_POOL_TIMEOUT.toString(),
    connection_timeout: env.DATABASE_CONNECTION_TIMEOUT.toString(),
    application_name: env.SERVICE_NAME,
  });

  console.log(`🔌 setting up run-ops read replica connection to ${redactUrlSecrets(replicaUrl)}`);

  const client = new RunOpsPrismaClient({
    datasources: { db: { url: replicaUrl.href } },
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "info" },
      { emit: "event", level: "warn" },
      ...((process.env.VERBOSE_PRISMA_LOGS === "1" ||
      process.env.VERY_SLOW_QUERY_THRESHOLD_MS !== undefined
        ? [{ emit: "event", level: "query" }]
        : []) as { emit: "event"; level: "query" }[]),
    ],
  });

  if (process.env.PRISMA_LOG_TO_STDOUT !== "1") {
    client.$on("info", (log) => logger.info("RunOpsPrismaClient info", { clientType, event: log }));
    client.$on("warn", (log) => logger.warn("RunOpsPrismaClient warn", { clientType, event: log }));
    client.$on("error", (log) =>
      logger.error("RunOpsPrismaClient error", { clientType, event: log })
    );
  }

  client.$on("query", (log) => queryPerformanceMonitor.onQuery("replica", log));

  const connectPromise = client.$connect();
  if (env.NODE_ENV === "test") {
    connectPromise.catch((error) => {
      logger.warn("Failed to eagerly connect run-ops prisma client (replica)", { error });
    });
  }

  console.log(`🔌 run-ops read replica connected`);

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

function extendQueryParams(hrefOrUrl: string | URL, queryParams: Record<string, string>) {
  const url = new URL(hrefOrUrl);
  const query = url.searchParams;

  for (const [key, val] of Object.entries(queryParams)) {
    query.set(key, val);
  }

  url.search = query.toString();

  return url;
}

function redactUrlSecrets(hrefOrUrl: string | URL) {
  const url = new URL(hrefOrUrl);
  url.password = "";
  return url.href;
}

export type { PrismaClient } from "@trigger.dev/database";

export const PrismaErrorSchema = z.object({
  code: z.string(),
});

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

export const DATABASE_SCHEMA = singleton("DATABASE_SCHEMA", getDatabaseSchema);

export const sqlDatabaseSchema = Prisma.sql([`${DATABASE_SCHEMA}`]);
