import {
  Prisma,
  PrismaClient,
  PrismaClientOrTransaction,
  PrismaReplicaClient,
  PrismaTransactionClient,
  PrismaTransactionOptions,
} from "@trigger.dev/database";
import invariant from "tiny-invariant";
import { z } from "zod";
import { env } from "./env.server";
import { logger } from "./services/logger.server";
import { isValidDatabaseUrl } from "./utils/db";
import { singleton } from "./utils/singleton";
import { $transaction as transac } from "@trigger.dev/database";
import { startActiveSpan } from "./v3/tracer.server";
import { Span } from "@opentelemetry/api";

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

  const databaseUrl = extendQueryParams(DATABASE_URL, {
    connection_limit: env.DATABASE_CONNECTION_LIMIT.toString(),
    pool_timeout: env.DATABASE_POOL_TIMEOUT.toString(),
    connection_timeout: env.DATABASE_CONNECTION_TIMEOUT.toString(),
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
      {
        emit: "stdout",
        level: "info",
      },
      {
        emit: "stdout",
        level: "warn",
      },
      ...((process.env.PRISMA_ERRORS_STDOUT_ENABLED === "1"
        ? [
            {
              emit: "stdout",
              level: "error",
            },
          ]
        : []) satisfies Prisma.LogDefinition[]),
      // verbose
      ...((process.env.VERBOSE_PRISMA_LOGS === "1"
        ? [
            {
              emit: "event",
              level: "query",
            },
            {
              emit: "stdout",
              level: "query",
            },
          ]
        : []) satisfies Prisma.LogDefinition[]),
    ],
  });

  client.$on("info", (log) => {
    logger.info("PrismaClient info", {
      clientType: "writer",
      timestamp: log.timestamp,
      message: log.message,
      target: log.target,
    });
  });

  client.$on("warn", (log) => {
    logger.warn("PrismaClient warn", {
      clientType: "writer",
      timestamp: log.timestamp,
      message: log.message,
      target: log.target,
    });
  });

  // Only use structured logging for errors if we're not already logging them to stdout
  if (process.env.PRISMA_ERRORS_STDOUT_ENABLED !== "1") {
    client.$on("error", (log) => {
      logger.error("PrismaClient error", {
        clientType: "writer",
        timestamp: log.timestamp,
        message: log.message,
        target: log.target,
      });
    });
  }

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

  const replicaUrl = extendQueryParams(env.DATABASE_READ_REPLICA_URL, {
    connection_limit: env.DATABASE_CONNECTION_LIMIT.toString(),
    pool_timeout: env.DATABASE_POOL_TIMEOUT.toString(),
    connection_timeout: env.DATABASE_CONNECTION_TIMEOUT.toString(),
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
      {
        emit: "stdout",
        level: "info",
      },
      {
        emit: "stdout",
        level: "warn",
      },
      ...((process.env.PRISMA_ERRORS_STDOUT_ENABLED === "1"
        ? [
            {
              emit: "stdout",
              level: "error",
            },
          ]
        : []) satisfies Prisma.LogDefinition[]),
      // verbose
      ...((process.env.VERBOSE_PRISMA_LOGS === "1"
        ? [
            {
              emit: "event",
              level: "query",
            },
            {
              emit: "stdout",
              level: "query",
            },
          ]
        : []) satisfies Prisma.LogDefinition[]),
    ],
  });

  replicaClient.$on("info", (log) => {
    logger.info("PrismaClient info", {
      clientType: "reader",
      timestamp: log.timestamp,
      message: log.message,
      target: log.target,
    });
  });

  replicaClient.$on("warn", (log) => {
    logger.warn("PrismaClient warn", {
      clientType: "reader",
      timestamp: log.timestamp,
      message: log.message,
      target: log.target,
    });
  });

  // Only use structured logging for errors if we're not already logging them to stdout
  if (process.env.PRISMA_ERRORS_STDOUT_ENABLED !== "1") {
    replicaClient.$on("error", (log) => {
      logger.error("PrismaClient error", {
        clientType: "reader",
        timestamp: log.timestamp,
        message: log.message,
        target: log.target,
      });
    });
  }

  // connect eagerly
  replicaClient.$connect();

  console.log(`🔌 read replica connected`);

  return replicaClient;
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
