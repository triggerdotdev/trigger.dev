import { logger, tasks } from "@trigger.dev/sdk";
// import { setDb } from "../db.js";

tasks.middleware("db", ({ ctx, payload, next }) => {
  logger.info("Hello, world from the middleware", { ctx, payload });
  return next();
});

tasks.onCancel(async ({ ctx, payload }) => {
  logger.info("Hello, world from the global cancel", { ctx, payload });
});

// tasks.onSuccess(({ ctx, payload, output }) => {
//   logger.info("Hello, world from the success", { ctx, payload });
// });

// tasks.onComplete(({ ctx, payload, output, error }) => {
//   logger.info("Hello, world from the success", { ctx, payload });
// });

// tasks.handleError(({ ctx, payload, error, retry, retryAt, retryDelayInMs }) => {
//   logger.info("Hello, world from the success", { ctx, payload });
// });

// tasks.onFailure(({ ctx, payload }) => {
//   logger.info("Hello, world from the failure", { ctx, payload });
// });

// tasks.onStart(({ ctx, payload }) => {
//   logger.info("Hello, world from the start", { ctx, payload });

//   setDb({
//     connect: async () => {
//       logger.info("Connecting to the database");
//     },
//   });
// });

// tasks.onWait(({ ctx, payload }) => {
//   logger.info("Hello, world from the start", { ctx, payload });
// });

// tasks.onResume(({ ctx, payload }) => {
//   logger.info("Hello, world from the start", { ctx, payload });
// });
