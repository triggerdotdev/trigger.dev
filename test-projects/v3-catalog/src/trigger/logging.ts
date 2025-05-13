import { logger, task, wait } from "@trigger.dev/sdk/v3";
import slugify from "@sindresorhus/slugify";

export const loggingTask = task({
  id: "logging-task",
  run: async () => {
    console.error("This is a console error message");
    logger.error("This is an error message");

    console.warn("This is a warning message");
    logger.warn("This is a warning message");

    console.log("This is a console log message");
    logger.log("This is a log message");

    logger.info("This is an info message");

    console.debug("This is a console debug message");
    logger.debug("This is a debug message");
  },
});

export const lotsOfLogs = task({
  id: "lots-of-logs",
  run: async ({ count = 400, delay = 10 }: { count?: number; delay?: number }) => {
    for (let i = 0; i < count; i++) {
      logger.info(
        `Log #${i}. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit, sed quia non numquam eius modi tempora incidunt ut labore et dolore magnam aliquam quaerat voluptatem. Ut enim ad minima veniam, quis nostrum exercitationem ullam corporis suscipit laboriosam, nisi ut aliquid ex ea commodi consequatur? Quis autem vel eum iure reprehenderit qui in ea voluptate velit esse quam nihil molestiae consequatur, vel illum qui dolorem eum fugiat quo voluptas nulla pariatur?`,
        {}
      );
      await sleepMs(delay);
    }
  },
});

function sleepMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
