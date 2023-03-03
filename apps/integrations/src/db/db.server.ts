import { PrismaClient, Prisma } from ".prisma/client";
import invariant from "tiny-invariant";

export { Prisma };

let prisma: PrismaClient;

declare global {
  // eslint-disable-next-line no-var
  var __db__: PrismaClient;
}

// this is needed because in development we don't want to restart
// the server with every change, but we want to make sure we don't
// create a new connection to the DB with every change either.
// in production we'll have a single connection to the DB.
if (process.env.NODE_ENV === "production") {
  prisma = getClient();
} else {
  if (!global.__db__) {
    global.__db__ = getClient();
  }
  prisma = global.__db__;
}

function getClient() {
  const { DATABASE_URL } = process.env;
  invariant(typeof DATABASE_URL === "string", "DATABASE_URL env var not set");

  // Remove the username:password in the url and print that to the console
  const urlWithoutCredentials = new URL(DATABASE_URL);
  urlWithoutCredentials.password = "";

  console.log(
    `1. 🔌 setting up prisma client to ${urlWithoutCredentials.toString()}`
  );

  const client = new PrismaClient({
    datasources: {
      db: {
        url: DATABASE_URL,
      },
    },
    log: ["warn", "error"],
  });

  console.log(`2.0 🔌 prisma client connecting`);

  // connect eagerly
  client.$connect();

  console.log(`3.0 🔌 prisma client connected`);

  return client;
}

export { prisma };
export type { PrismaClient } from ".prisma/client";
