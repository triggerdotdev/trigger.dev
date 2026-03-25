import { PrismaClient } from "./generated/prisma/client.js";
export * as sql from "./generated/prisma/sql/index.js";

export const db = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});
