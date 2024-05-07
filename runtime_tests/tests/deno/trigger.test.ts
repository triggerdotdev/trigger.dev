import { createMiddleware } from "npm:@trigger.dev/hono@0.0.0-cross-runtime-20231204162532";
import {
  TriggerClient,
  invokeTrigger,
} from "npm:@trigger.dev/sdk@0.0.0-cross-runtime-20231204162532";
import { Hono } from "https://deno.land/x/hono@v3.10.3/mod.ts";
import { assertEquals } from "./deps.ts";

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
    run: async () => {},
  });

  app.use("/api/trigger", createMiddleware(client));

  return app;
}

Deno.test("Deno", async () => {
  const app = createApp();

  const req = new Request("http://localhost/api/trigger", {
    method: "POST",
    headers: {
      "x-trigger-api-key": "tr_dev_test-api-key",
      "x-trigger-action": "INDEX_ENDPOINT",
      "x-trigger-version": "2023-11-01",
    },
  });
  const res = await app.request(req);
  assertEquals(res.status, 200);

  const body: any = await res.json();

  assertEquals(body.jobs.length, 1);
  assertEquals(body.jobs[0].id, "wrangler-job");
});
