import { eventTrigger } from "@trigger.dev/sdk";
import { client } from "@/trigger";
import { fetchFunction } from "@trigger.dev/functions";

client.defineJob({
  id: "function-usage-1",
  name: "Background Function Usage",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "example.event",
  }),
  run: async (payload, io, ctx) => {
    const output = await fetchFunction.invoke("fetch-1", {
      userName: "ericallam",
    });

    return { output };
  },
});
