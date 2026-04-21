import {
  Prisma,
  PrismaClient,
  $transaction as transac,
  type PrismaClientOrTransaction,
  type PrismaReplicaClient,
  type PrismaTransactionClient,
  type PrismaTransactionOptions,
} from "@trigger.dev/database";
import { PrismaPg } from "@prisma/adapter-pg";
import { createHash } from "node:crypto";
import invariant from "tiny-invariant";
import { z } from "zod";
import { env } from "./env.server";
import { logger } from "./services/logger.server";
import { isValidDatabaseUrl } from "./utils/db";
import { singleton } from "./utils/singleton";
import { startActiveSpan } from "./v3/tracer.server";
import { Span } from "@opentelemetry/api";
import { queryPerformanceMonitor } from "./utils/queryPerformanceMonitor.server";

export type {
  PrismaTransactionClient,
  PrismaClientOrTransaction,
  PrismaTransactionOptions,
  PrismaReplicaClient,
};

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

      return transac(
        prisma,
        (client) => fn(client, span),
        (error) => {
          logger.error("prisma.$transaction error", {
            code: error.code,
            meta: error.meta,
            stack: error.stack,
            message: error.message,
            name: error.name,
          });
        },
        options
      );
    });
  } else {
    return transac(
      prisma,
      fnOrName,
      (error) => {
        logger.error("prisma.$transaction error", {
          code: error.code,
          meta: error.meta,
          stack: error.stack,
          message: error.message,
          name: error.name,
        });
      },
      typeof fnOrOptions === "function" ? undefined : fnOrOptions
    );
  }
}

export { Prisma };

export const prisma = singleton("prisma", getClient);

export const $replica: PrismaReplicaClient = singleton(
  "replica",
  () => getReplicaClient() ?? prisma
);

function getClient() {
  const { DATABASE_URL } = process.env;
  invariant(typeof DATABASE_URL === "string", "DATABASE_URL env var not set");

  const databaseUrl = new URL(DATABASE_URL);

  // Set application_name as a query param on the connection string (pg understands this)
  databaseUrl.searchParams.set("application_name", env.SERVICE_NAME);

  console.log(`🔌 setting up prisma client to ${redactUrlSecrets(databaseUrl)}`);

  const adapter = new PrismaPg(
    {
      connectionString: databaseUrl.href,
      max: env.DATABASE_CONNECTION_LIMIT,
      idleTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT * 1000,
      connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT * 1000,
    },
    {
      // Generate deterministic prepared statement names from query SQL so PostgreSQL
      // can reuse cached query plans. Without this, every query uses an anonymous
      // prepared statement that PG must parse and plan from scratch each time.
      statementNameGenerator: (query) => `p_${createHash("sha256").update(query.sql).digest("hex").slice(0, 16)}`,
    }
  );

  const client = new PrismaClient({
    adapter,
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
        clientType: "writer",
        event: {
          timestamp: log.timestamp,
          message: log.message,
          target: log.target,
        },
      });
    });

    client.$on("warn", (log) => {
      logger.warn("PrismaClient warn", {
        clientType: "writer",
        event: {
          timestamp: log.timestamp,
          message: log.message,
          target: log.target,
        },
      });
    });

    client.$on("error", (log) => {
      logger.error("PrismaClient error", {
        clientType: "writer",
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

  // connect eagerly
  client.$connect();

  console.log(`🔌 prisma client connected`);

  return client;
}

function getReplicaClient() {
  if (!env.DATABASE_READ_REPLICA_URL) {
    console.log(`🔌 No database replica, using the regular client`);
    return;
  }

  const replicaUrl = new URL(env.DATABASE_READ_REPLICA_URL);
  replicaUrl.searchParams.set("application_name", env.SERVICE_NAME);

  console.log(`🔌 setting up read replica connection to ${redactUrlSecrets(replicaUrl)}`);

  const adapter = new PrismaPg(
    {
      connectionString: replicaUrl.href,
      max: env.DATABASE_CONNECTION_LIMIT,
      idleTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT * 1000,
      connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT * 1000,
    },
    {
      statementNameGenerator: (query) => `p_${createHash("sha256").update(query.sql).digest("hex").slice(0, 16)}`,
    }
  );

  const replicaClient = new PrismaClient({
    adapter,
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
        clientType: "reader",
        event: {
          timestamp: log.timestamp,
          message: log.message,
          target: log.target,
        },
      });
    });

    replicaClient.$on("warn", (log) => {
      logger.warn("PrismaClient warn", {
        clientType: "reader",
        event: {
          timestamp: log.timestamp,
          message: log.message,
          target: log.target,
        },
      });
    });

    replicaClient.$on("error", (log) => {
      logger.error("PrismaClient error", {
        clientType: "reader",
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

  // connect eagerly
  replicaClient.$connect();

  console.log(`🔌 read replica connected`);

  return replicaClient;
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
