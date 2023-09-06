// tasks.background.ts
import { client } from "@/trigger";
import { z } from "zod";

export default client.defineBackgroundTask({
  id: "task-1",
  name: "Task 1",
  version: "1.0.0",
  schema: z.object({
    userName: z.string(),
  }),
  cpu: 1,
  memory: 256,
  concurrency: 5,
  secrets: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  },
  run: async (payload) => {
    // This code will run in the background, as it will be bundled and shipped to a trigger.dev background worker
    await new Promise((resolve) => setTimeout(resolve, 100000));

    return `Task Response for user ${payload.userName}`;
  },
});
