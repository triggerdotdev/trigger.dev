import { task, batch } from "@trigger.dev/sdk/v3";
import { ErrorTask } from "./throwError.js";
import { SpanSpammerTask } from "./spanSpammer.js";
import { logSpammerTask } from "./logSpammer.js";

export const seedTask = task({
  id: "seed-task",
  run: async (payload: any, { ctx }) => {
    let tasksToRun = [];

    for (let i = 0; i < 10; i++) {
      tasksToRun.push({
        id: "simple-throw-error",
        payload: {},
        options: { delay: `${i}s` },
      });
    }

    tasksToRun.push({
      id: "span-spammer",
      payload: {},
    });

    tasksToRun.push({
      id: "log-spammer",
      payload: {},
    });

    await batch.triggerAndWait(tasksToRun);
    return;
  },
});
