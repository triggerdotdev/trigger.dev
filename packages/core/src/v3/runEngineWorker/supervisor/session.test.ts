import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { SupervisorSession } from "./session.js";
import type { WorkerApiDequeueRequestBody } from "./schemas.js";

describe("SupervisorSession queue selection", () => {
  it.each<{
    name: string;
    selection: Pick<WorkerApiDequeueRequestBody, "queueClass" | "subscriptions">;
  }>([
    { name: "legacy default", selection: { queueClass: "default" } },
    { name: "legacy scheduled", selection: { queueClass: "scheduled" } },
    {
      name: "v2 subscriptions",
      selection: {
        subscriptions: [
          { class: "ondemand", phase: "fresh", compat: "any", channel: "stable", weight: 0.25 },
          { class: "ondemand", phase: "restore", compat: "container", channel: "canary" },
        ],
      },
    },
  ])("sends $name through the existing dequeue endpoint", async ({ selection }) => {
    let receiveDequeue!: (request: { path: string | undefined; body: unknown }) => void;
    const dequeued = new Promise<{ path: string | undefined; body: unknown }>((resolve) => {
      receiveDequeue = resolve;
    });
    const server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/engine/v1/worker-actions/connect") {
        response.end(JSON.stringify({ ok: true, workerGroup: { type: "MANAGED", name: "test" } }));
        return;
      }

      let body = "";
      for await (const chunk of request) body += chunk;
      response.end("[]");
      receiveDequeue({ path: request.url, body: JSON.parse(body) });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const session = new SupervisorSession({
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      workerToken: "test-token",
      instanceName: "test-worker",
      queueConsumerEnabled: true,
      runNotificationsEnabled: false,
      heartbeatIntervalSeconds: 3600,
      dequeueIntervalMs: 10,
      dequeueIdleIntervalMs: 10,
      maxRunCount: 1,
      scaling: { strategy: "none", minConsumerCount: 1, maxConsumerCount: 1 },
      ...selection,
    });

    try {
      await session.start();
      expect(await dequeued).toEqual({
        path: "/engine/v1/worker-actions/dequeue",
        body: { maxRunCount: 1, ...selection },
      });
    } finally {
      await session.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
