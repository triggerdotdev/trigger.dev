import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";
import type { WorkerQueueSubscription } from "@trigger.dev/core/v3/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  seedEngineFixtures,
  workerHeaders,
  type EngineFixtures,
} from "../../test/bench/lib/engineFixtures";

const WORKER_GROUP_ID = "worker-group-legacy-auth";
const LEGACY_MASTER_QUEUE = "my workers";
const subscription: WorkerQueueSubscription = {
  class: "ondemand",
  phase: "fresh",
  compat: "container",
  channel: "stable",
};

let server: TestServer;
let fixtures: EngineFixtures;

beforeAll(async () => {
  server = await startTestServer({
    extraEnv: {
      RUN_ENGINE_WORKER_QUEUE_SUBSCRIPTIONS: JSON.stringify({
        [WORKER_GROUP_ID]: [subscription],
      }),
    },
    overrideEnv: { RUN_ENGINE_WORKER_ENABLED: "1" },
  });
  fixtures = await seedEngineFixtures(server.prisma, {
    taskCount: 1,
    workerGroupId: WORKER_GROUP_ID,
    masterQueue: LEGACY_MASTER_QUEUE,
    enableFastPath: true,
  });
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

function workerAction(path: string, body: unknown) {
  return server.webapp.fetch(path, {
    method: "POST",
    headers: workerHeaders(fixtures, "legacy-worker-instance"),
    body: JSON.stringify(body),
  });
}

describe("dequeue request validation", () => {
  it("authenticates legacy workers and rejects invalid requests without popping their queue", async () => {
    const heartbeat = await workerAction("/engine/v1/worker-actions/heartbeat", {
      cpu: { used: 0, available: 1 },
      memory: { used: 0, available: 1 },
      tasks: [],
    });
    expect(heartbeat.status).toBe(200);

    const trigger = await server.webapp.fetch(
      `/api/v1/tasks/${fixtures.taskIdentifiers[0]!}/trigger`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fixtures.environmentApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ payload: { message: "dequeue route validation" } }),
      }
    );
    expect(trigger.ok).toBe(true);

    const invalidRequests: Array<[body: unknown, status: number]> = [
      [{ queueClass: "restore" }, 400],
      [{ maxRunCount: "invalid" }, 400],
      [{ maxResources: { cpu: "invalid", memory: 1 } }, 400],
      [{ subscriptions: [] }, 422],
      [{ subscriptions: [{ ...subscription, weight: 2 }] }, 422],
      [{ queueClass: "default", subscriptions: [subscription] }, 422],
      [{ maxRunCount: "invalid", subscriptions: [] }, 400],
      [{ queueClass: "invalid", subscriptions: [subscription] }, 400],
    ];
    for (const [body, status] of invalidRequests) {
      expect((await workerAction("/engine/v1/worker-actions/dequeue", body)).status).toBe(status);
    }

    const invalidV2Region = await workerAction("/engine/v1/worker-actions/dequeue", {
      subscriptions: [subscription],
    });
    expect(invalidV2Region.status).toBe(422);

    const legacyDequeue = await workerAction("/engine/v1/worker-actions/dequeue", {});
    expect(legacyDequeue.status).toBe(200);
    expect(await legacyDequeue.json()).toHaveLength(1);

    const emptyDequeue = await workerAction("/engine/v1/worker-actions/dequeue", {});
    expect(emptyDequeue.status).toBe(200);
    expect(await emptyDequeue.json()).toEqual([]);
  }, 180_000);
});
