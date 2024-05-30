import dotenv from "dotenv";
import { simpleChildTask } from "./trigger/subtasks";

dotenv.config();

export async function run() {
  await simpleChildTask.trigger({ message: "Regular queue" });
  await simpleChildTask.trigger(
    { message: "Simple alt queue 1" },
    {
      queue: {
        name: "queue-concurrency-3",
        concurrencyLimit: 1,
      },
    }
  );
  await simpleChildTask.trigger(
    { message: "Simple alt queue 2" },
    {
      queue: {
        name: "queue-concurrency-3",
        concurrencyLimit: 1,
      },
    }
  );

  await simpleChildTask.batchTrigger([{ payload: { message: "Regular queue" } }]);
  await simpleChildTask.batchTrigger([
    {
      payload: { message: "Batched alt queue 1" },
      options: {
        queue: {
          name: "queue-concurrency-3",
          concurrencyLimit: 1,
        },
      },
    },
    {
      payload: { message: "Batched alt queue 2" },
      options: {
        queue: {
          name: "queue-concurrency-3",
          concurrencyLimit: 1,
        },
      },
    },
    {
      payload: { message: "Batched alt queue 3" },
      options: {
        queue: {
          name: "queue-concurrency-3",
          concurrencyLimit: 1,
        },
      },
    },
  ]);
}

run().catch(console.error);
