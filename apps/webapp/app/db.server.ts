import { PrismaClient, Prisma } from ".prisma/client";
import invariant from "tiny-invariant";
import { env } from "./env.server";

export { Prisma };

let prisma: PrismaClient;

declare global {
  var __db__: PrismaClient;
}

// this is needed because in development we don't want to restart
// the server with every change, but we want to make sure we don't
// create a new connection to the DB with every change either.
// in production we'll have a single connection to the DB.
if (env.NODE_ENV === "production") {
  prisma = getClient();
} else {
  if (!global.__db__) {
    global.__db__ = getClient();
  }
  prisma = global.__db__;
}

function getClient() {
  const { DATABASE_URL } = env;
  invariant(typeof DATABASE_URL === "string", "DATABASE_URL env var not set");

  console.log(`🔌 setting up prisma client to ${DATABASE_URL}`);

  const client = new PrismaClient({
    datasources: {
      db: {
        url: DATABASE_URL,
      },
    },
  });

  // connect eagerly
  client.$connect();

  return client;
}

export { prisma };
export type { PrismaClient } from ".prisma/client";
