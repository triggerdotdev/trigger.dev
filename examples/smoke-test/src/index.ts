import { Trigger, EntryPoint, customEvent, sendEvent } from "@trigger.dev/sdk";
import express from "express";

const entryPoint = new EntryPoint({
  apiKey: process.env.TRIGGER_API_KEY,
});

new Trigger({
  id: "my-workflow",
  name: "My workflow",
  logLevel: "debug",
  on: customEvent({ name: "user.created" }),
  run: async (event, ctx) => {
    await ctx.logger.info("Inside the smoke test workflow, received event", {
      event,
      myDate: new Date(),
    });

    return { foo: "bar" };
  },
}).register(entryPoint);

// Create an express app and listen on port 3007
const app = express();

app.use(express.json());

app.post("/__trigger/entry", async (req, res) => {
  const event = req.body;

  res.json({ ok: true });
});

app.listen(3007, async () => {
  console.log("Listening on port 3007");

  await entryPoint.listen({
    url: "http://localhost:3007/__trigger/entry",
  });
});
