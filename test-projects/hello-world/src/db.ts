import { locals } from "@trigger.dev/sdk";
import { logger, tasks } from "@trigger.dev/sdk";

const DbLocal = locals.create<{ connect: () => Promise<void>; disconnect: () => Promise<void> }>(
  "db"
);

export function getDb() {
  return locals.getOrThrow(DbLocal);
}

export function setDb(db: { connect: () => Promise<void> }) {
  locals.set(DbLocal, db);
}

tasks.middleware("db", async ({ ctx, payload, next, task }) => {
  const db = locals.set(DbLocal, {
    connect: async () => {
      logger.info("Connecting to the database");
    },
    disconnect: async () => {
      logger.info("Disconnecting from the database");
    },
  });

  await db.connect();

  logger.info("Hello, world from BEFORE the next call", { ctx, payload });
  await next();

  logger.info("Hello, world from AFTER the next call", { ctx, payload });

  await db.disconnect();
});

tasks.onWait("db", async ({ ctx, payload, task }) => {
  logger.info("Hello, world from ON WAIT", { ctx, payload });

  const db = getDb();
  await db.disconnect();
});

tasks.onResume("db", async ({ ctx, payload, task }) => {
  logger.info("Hello, world from ON RESUME", { ctx, payload });

  const db = getDb();
  await db.connect();
});
