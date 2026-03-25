import { PrismaClient } from "./generated/prisma/client.js";

export const db = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});
