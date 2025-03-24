import { locals } from "@trigger.dev/sdk";
import { logger, tasks } from "@trigger.dev/sdk";

const DbLocal = locals.create<{ connect: () => Promise<void> }>("db");

export function getDb() {
  return locals.getOrThrow(DbLocal);
}

export function setDb(db: { connect: () => Promise<void> }) {
  locals.set(DbLocal, db);
}

// tasks.middleware("db", ({ ctx, payload, next, task }) => {
//   locals.set(DbLocal, {
//     connect: async () => {
//       logger.info("Connecting to the database");
//     },
//   });

//   logger.info("Hello, world from the middleware", { ctx, payload });
//   return next();
// });
