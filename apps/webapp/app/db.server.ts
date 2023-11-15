import { PrismaClient, Prisma } from "@trigger.dev/database";
import invariant from "tiny-invariant";
import { z } from "zod";
import { logger } from "./services/logger.server";
import { env } from "./env.server";
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

function getClient() {
  const { DATABASE_URL } = process.env;
  invariant(typeof DATABASE_URL === "string", "DATABASE_URL env var not set");

  const databaseUrl = new URL(DATABASE_URL);

  // We need to add the connection_limit and pool_timeout query params to the url, in a way that works if the DATABASE_URL already has query params
  const query = databaseUrl.searchParams;
  query.set("connection_limit", env.DATABASE_CONNECTION_LIMIT.toString());
  query.set("pool_timeout", env.DATABASE_POOL_TIMEOUT.toString());
  databaseUrl.search = query.toString();

  // Remove the username:password in the url and print that to the console
  const urlWithoutCredentials = new URL(databaseUrl.href);
  urlWithoutCredentials.password = "";

  console.log(`🔌 setting up prisma client to ${urlWithoutCredentials.toString()}`);

  const client = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl.href,
      },
    },
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
      // {
      //   emit: "stdout",
      //   level: "query",
      // },
    ],
  });

  // client.$on("query", (e) => {
  //   console.log("Query: " + e.query);
  //   console.log("Params: " + e.params);
  //   console.log("Duration: " + e.duration + "ms");
  // });

  // connect eagerly
  client.$connect();

  console.log(`🔌 prisma client connected`);

  return client;
}

export type { PrismaClient } from "@trigger.dev/database";

export const PrismaErrorSchema = z.object({
  code: z.string(),
});
