import { task } from "@trigger.dev/sdk/v3";
import { parseISO } from "date-fns";

export const helloWorldTask = task({
  id: "hello-world",
  run: async (payload) => {
    console.log("Hello, World!", payload, parseISO(new Date().toISOString()));
  },
});
