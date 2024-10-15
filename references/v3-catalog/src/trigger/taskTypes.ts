import { task, schemaTask } from "@trigger.dev/sdk/v3";
import { z } from "zod";

export const task1 = task({
  id: "types/task-1",
  run: async (payload: { foo: string }) => {
    return { hello: "world" };
  },
});

const Task2Payload = z.object({
  bar: z.string(),
});

export const task2 = schemaTask({
  id: "types/task-2",
  schema: Task2Payload,
  run: async (payload) => {
    return { goodbye: "world" as const };
  },
});
