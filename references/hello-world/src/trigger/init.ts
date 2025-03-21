import { logger, tasks } from "@trigger.dev/sdk";

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
// });

// tasks.onWait(({ ctx, payload }) => {
//   logger.info("Hello, world from the start", { ctx, payload });
// });

// tasks.onResume(({ ctx, payload }) => {
//   logger.info("Hello, world from the start", { ctx, payload });
// });

tasks.onInit("logging", ({ ctx, payload, task }) => {
  logger.info("Hello, world from the init", { ctx, payload, task });
});
