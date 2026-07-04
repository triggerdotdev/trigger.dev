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
  return replica ? captureInfrastructureErrors(tagDatasource("replica", replica)) : prisma;
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
  newUrl?: string;
  newReplicaUrl?: string;
};
export type RunOpsClientBuilders = {
  controlPlane: RunOpsClients;
  buildNewWriter: (url: string, clientType: string) => RunOpsPrismaClient;
  buildNewReplica: (url: string, clientType: string) => RunOpsPrismaClient;
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

  const legacyRunOps = controlPlane;

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

  return selectRunOpsTopology(
    {
      splitEnabled,
      legacyUrl: env.RUN_OPS_LEGACY_DATABASE_URL,
      newUrl,
      newReplicaUrl: env.RUN_OPS_DATABASE_READ_REPLICA_URL,
    },
    {
      controlPlane: { writer: prisma, replica: $replica },
      buildNewWriter: (url, clientType) =>
        captureInfraErrorsRunOps(
          tagDatasourceRunOps("writer", buildRunOpsWriterClient({ url, clientType }))
        ),
      buildNewReplica: (url, clientType) =>
        captureInfraErrorsRunOps(
          tagDatasourceRunOps("replica", buildRunOpsReplicaClient({ url, clientType }))
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
export const runOpsLegacyPrisma: PrismaClient = runOpsTopology.legacyRunOps.writer;
export const runOpsLegacyReplica: PrismaReplicaClient = runOpsTopology.legacyRunOps.replica;

export const runOpsSplitReadEnabled: boolean = computeRunOpsSplitReadEnabled({
  newReplica: runOpsNewReplicaClient,
  controlPlaneWriter: prisma,
  controlPlaneReplica: $replica,
  hasNewUrl: !!env.RUN_OPS_DATABASE_URL,
  hasLegacyUrl: !!env.RUN_OPS_LEGACY_DATABASE_URL,
});

// Boot-time interlock: if the flag is on but the distinct-DB sentinel does not
// confirm two physically-distinct run-ops DBs, refuse to enable split (data-loss
// interlock). Async, so it cannot live in the synchronous singleton factory —
// call it from the eager-boot path before any run-ops routing is wired.
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
    connection_limit: env.DATABASE_CONNECTION_LIMIT.toString(),
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
