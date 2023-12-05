import { createAdaptorServer } from "@hono/node-server";
import request from "supertest";
import { createMiddleware } from "@trigger.dev/hono";
import { TriggerClient, invokeTrigger } from "@trigger.dev/sdk";
import { Hono } from "hono";

function createApp() {
  const client = new TriggerClient({
    id: "wrangler-test",
    apiKey: "tr_dev_test-api-key",
    apiUrl: "http://localhost:3030",
  });

  const app = new Hono();

  client.defineJob({
    id: "wrangler-job",
    name: "Wrangler Job",
    version: "1.0.0",
    trigger: invokeTrigger(),
    run: async (payload, io, ctx) => {},
  });

  app.use("/api/trigger", createMiddleware(client));

  return app;
}

describe("Node", () => {
  const app = createApp();
  const server = createAdaptorServer(app);

  it("Should be indexable at /api/trigger", async () => {
    const res = await request(server).post("/api/trigger").set({
      "x-trigger-api-key": "tr_dev_test-api-key",
      "x-trigger-action": "INDEX_ENDPOINT",
      "x-trigger-version": "2023-11-01",
    });

    expect(res.status).toBe(200);

    const body = JSON.parse(res.text);

    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].id).toBe("wrangler-job");
  });
});
