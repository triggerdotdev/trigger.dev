import { PrismaClient } from "@prisma/client";
export * as sql from "@prisma/client/sql";

export const db = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});
