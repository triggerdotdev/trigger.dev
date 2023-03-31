import {
  Job,
  TriggerClient,
  customEvent,
  NormalizedRequest,
} from "@trigger.dev/sdk";
import express from "express";

export const client = new TriggerClient("smoke-test", {
  apiKey: "trigger_development_cu7JBXifLr4j",
  apiUrl: "http://localhost:3000",
  endpoint: "http://localhost:3007/__trigger/entry",
  logLevel: "debug",
});

new Job({
  id: "my-job",
  name: "My Job",
  version: "0.0.1",
  logLevel: "debug",
  trigger: customEvent({ name: "smoke.text" }),
  run: async (event, ctx) => {
    await ctx.logger.debug("Inside the smoke test workflow, received event", {
      event,
      myDate: new Date(),
    });

    await ctx.wait("⏲", 10);

    await ctx.logger.debug("In between the two waits", {
      event,
      myDate: new Date(),
    });

    await ctx.sendEvent("Event 1", {
      name: "smoke.test",
      payload: { foo: "bar" },
      source: "smoke-test",
    });

    await ctx.wait("⏲⏲", 10);

    await ctx.sendEvent(
      "Event 2",
      {
        name: "smoke.test.delayed",
        payload: { foo: "bar", delayed: true },
        source: "smoke-test",
      },
      { deliverAfter: 30 }
    );

    return { foo: "bar" };
  },
}).registerWith(client);

// Create an express app and listen on port 3007
const app = express();

app.use(express.json());

app.get("/__trigger/entry", expressHandler);
app.post("/__trigger/entry", expressHandler);

async function expressHandler(req: express.Request, res: express.Response) {
  const normalizedRequest = normalizeExpressRequest(req);

  const response = await client.handleRequest(normalizedRequest);

  if (!response) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.status(response.status).json(response.body);
}

app.listen(3007, async () => {
  console.log("Listening on port 3007");

  await client.listen();
});

// Converts a request from express to a request that can be passed to the
// TriggerClient, that any other type of request can be converted to.
// query is a Record<string, string>
// same with headers
function normalizeExpressRequest(req: express.Request): NormalizedRequest {
  const normalizedHeaders = Object.entries(req.headers).reduce(
    (acc, [key, value]) => {
      acc[key] = value as string;
      return acc;
    },
    {} as Record<string, string>
  );

  const normalizedQuery = Object.entries(req.query).reduce(
    (acc, [key, value]) => {
      acc[key] = value as string;
      return acc;
    },
    {} as Record<string, string>
  );

  return {
    body: req.body,
    headers: normalizedHeaders,
    method: req.method,
    query: normalizedQuery,
    url: req.url,
  };
}
