import { PrismaClient } from "@trigger.dev/database";

// Dedicated client for trigger tasks. Importing the webapp's `~/db.server`
// pulls in `~/v3/tracer.server`, whose module-load OTel registration collides
// with the worker's own ("Attempted duplicate registration of API: trace").
export const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
});
