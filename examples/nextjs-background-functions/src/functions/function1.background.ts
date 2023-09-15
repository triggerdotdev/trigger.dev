// tasks.background.ts
import { client } from "@/trigger";
import { z } from "zod";

export default client.defineBackgroundFunction({
  id: "function-1",
  name: "Function 1",
  version: "1.0.2",
  schema: z.object({
    userName: z.string(),
  }),
  run: async (payload) => {
    // This code will run in the background, as it will be bundled and shipped to a trigger.dev background worker
    await new Promise((resolve) => setTimeout(resolve, 100000));

    return {
      username: payload.userName,
      foo: "bar",
      message: `Function Response for user ${payload.userName}`,
    };
  },
});
