import dotenv from "dotenv";
import { simpleChildTask } from "./trigger/subtasks";

dotenv.config();

export async function run() {
  await simpleChildTask.trigger({ message: "Regular queue" });
  await simpleChildTask.trigger(
    { message: "Alt queue" },
    {
      queue: {
        name: "queue-concurrency-3",
        concurrencyLimit: 3,
      },
    }
  );

  await simpleChildTask.batchTrigger([{ payload: { message: "Regular queue" } }]);
  await simpleChildTask.batchTrigger([
    {
      payload: { message: "Regular queue" },
      options: {
        queue: {
          name: "queue-concurrency-3",
          concurrencyLimit: 3,
        },
      },
    },
  ]);
}

run().catch(console.error);
