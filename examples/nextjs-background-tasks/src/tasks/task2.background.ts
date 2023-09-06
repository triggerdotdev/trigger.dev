import { client } from "@/trigger";
import { z } from "zod";

export default client.defineBackgroundTask({
  id: "task-2",
  name: "Task 2",
  version: "1.0.0",
  schema: z.object({
    id: z.string(),
  }),
  run: async (payload) => {
    return `Task Response for user ${payload.id}`;
  },
});
