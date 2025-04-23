import { logger, task, wait } from "@trigger.dev/sdk/v3";
import { childTask } from "./example.js";

/*
 * These aren't currently supported, and so should throw clear errors
 */
export const parallelWaits = task({
  id: "parallel-waits",
  run: async ({ skipDuration = false }: { skipDuration?: boolean }) => {
    //parallel wait for 5/10 seconds
    if (!skipDuration) {
      await Promise.all([
        wait.for({ seconds: 5 }),
        wait.until({ date: new Date(Date.now() + 10_000) }),
      ]);
    }

    //parallel task call
    await Promise.all([
      childTask.triggerAndWait({ message: "Hello, world!" }),
      childTask.batchTriggerAndWait([{ payload: { message: "Hello, world!" } }]),
    ]);
  },
});
