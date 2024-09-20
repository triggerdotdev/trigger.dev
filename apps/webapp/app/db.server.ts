import { Prisma, PrismaClient } from "@trigger.dev/database";
import invariant from "tiny-invariant";
import { z } from "zod";
import { env } from "./env.server";
import { logger } from "./services/logger.server";
import { isValidDatabaseUrl } from "./utils/db";
import { singleton } from "./utils/singleton";

export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type PrismaClientOrTransaction = PrismaClient | PrismaTransactionClient;

function isTransactionClient(prisma: PrismaClientOrTransaction): prisma is PrismaTransactionClient {
  return !("$transaction" in prisma);
}

function isPrismaKnownError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
  );
}

export type PrismaTransactionOptions = {
  /** The maximum amount of time (in ms) Prisma Client will wait to acquire a transaction from the database. The default value is 2000ms. */
  maxWait?: number;

  /** The maximum amount of time (in ms) the interactive transaction can run before being canceled and rolled back. The default value is 5000ms. */
  timeout?: number;

  /**  Sets the transaction isolation level. By default this is set to the value currently configured in your database. */
  isolationLevel?: Prisma.TransactionIsolationLevel;

  swallowPrismaErrors?: boolean;
};

export async function $transaction<R>(
  prisma: PrismaClientOrTransaction,
  fn: (prisma: PrismaTransactionClient) => Promise<R>,
  options?: PrismaTransactionOptions
): Promise<R | undefined> {
  if (isTransactionClient(prisma)) {
    return fn(prisma);
  }

  try {
    return await (prisma as PrismaClient).$transaction(fn, options);
  } catch (error) {
    if (isPrismaKnownError(error)) {
      logger.error("prisma.$transaction error", {
        code: error.code,
        meta: error.meta,
        stack: error.stack,
        message: error.message,
        name: error.name,
      });

      if (options?.swallowPrismaErrors) {
        return;
      }
    }

    throw error;
  }
}

export { Prisma };

export const prisma = singleton("prisma", getClient);

export type PrismaReplicaClient = Omit<PrismaClient, "$transaction">;

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
  });

  console.log(`🔌 setting up prisma client to ${redactUrlSecrets(databaseUrl)}`);

  const client = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl.href,
      },
    },
    // @ts-expect-error
    log: [
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
    ].concat(
      process.env.VERBOSE_PRISMA_LOGS === "1"
        ? [
            { emit: "event", level: "query" },
            { emit: "stdout", level: "query" },
          ]
        : []
    ),
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

  const replicaUrl = extendQueryParams(env.DATABASE_READ_REPLICA_URL, {
    connection_limit: env.DATABASE_CONNECTION_LIMIT.toString(),
    pool_timeout: env.DATABASE_POOL_TIMEOUT.toString(),
  });

  console.log(`🔌 setting up read replica connection to ${redactUrlSecrets(replicaUrl)}`);

  const replicaClient = new PrismaClient({
    datasources: {
      db: {
        url: replicaUrl.href,
      },
    },
    // @ts-expect-error
    log: [
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
    ].concat(
      process.env.VERBOSE_PRISMA_LOGS === "1"
        ? [
            { emit: "event", level: "query" },
            { emit: "stdout", level: "query" },
          ]
        : []
    ),
  });

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
