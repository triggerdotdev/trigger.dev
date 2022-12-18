import { z } from "zod";
import { Workflow, onEvent } from "@trigger.dev/sdk";

const userCreatedEvent = z.object({
  id: z.string(),
});

const workflow = new Workflow({
  id: "my-workflow",
  name: "My workflow",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  trigger: onEvent({ name: "user.created", schema: userCreatedEvent }),
  run: async (event) => {
    console.log("Inside the smoke test workflow, received event", event);
  },
});

workflow.listen();
