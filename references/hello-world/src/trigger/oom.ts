import { OutOfMemoryError } from "@trigger.dev/sdk/v3";
import { logger, task } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";

export const oomTask = task({
  id: "oom-task",
  machine: "micro",
  retry: {
    outOfMemory: {
      machine: "small-1x",
    },
  },
  run: async (
    {
      succeedOnLargerMachine = false,
      ffmpeg = false,
      manual = false,
    }: { succeedOnLargerMachine?: boolean; ffmpeg?: boolean; manual?: boolean },
    { ctx }
  ) => {
    logger.info("running out of memory below this line");

    logger.info(`Running on ${ctx.machine?.name}`);

    await setTimeout(2000);

    if (ctx.machine?.name !== "micro" && succeedOnLargerMachine) {
      logger.info("Going to succeed now");
      return {
        success: true,
      };
    }

    if (manual) {
      throw new OutOfMemoryError();
    }

    if (ffmpeg) {
      throw new Error("ffmpeg was killed with signal SIGKILL");
    }

    let a = "a";

    try {
      while (true) {
        a += a;
      }
    } catch (error) {
      logger.error(error instanceof Error ? error.message : "Unknown error", { error });

      let b = [];
      while (true) {
        b.push(a.replace(/a/g, "b"));
      }
    }
  },
});

export const oomTask2 = task({
  id: "oom-task-2",
  machine: "micro",
  run: async (payload: any, { ctx }) => {
    await runMemoryLeakScenario();
  },
});

async function runMemoryLeakScenario() {
  console.log("🧠 Starting memory leak simulation");
  const memoryHogs = [];
  let iteration = 0;

  while (iteration < 1000) {
    // Allocate large chunks of memory
    const bigArray = new Array(10000000).fill(`memory-leak-data-${iteration}`);
    memoryHogs.push(bigArray);

    await setTimeout(200);
    iteration++;

    const memUsage = process.memoryUsage();
    console.log(
      `🧠 Memory leak iteration ${iteration}, RSS: ${Math.round(memUsage.rss / 1024 / 1024)} MB`
    );
  }

  console.log("🧠 Memory leak scenario completed");
}
