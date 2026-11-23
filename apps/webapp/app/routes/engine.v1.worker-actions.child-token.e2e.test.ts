import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";
import { createHash, randomBytes } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  seedEngineFixtures,
  workerHeaders,
  type EngineFixtures,
} from "../../test/bench/lib/engineFixtures";

const WORKER_GROUP_ID = "worker-group-child-tokens";

let server: TestServer;
let fixtures: EngineFixtures;

beforeAll(async () => {
  server = await startTestServer();
  fixtures = await seedEngineFixtures(server.prisma, {
    taskCount: 1,
    workerGroupId: WORKER_GROUP_ID,
    masterQueue: "child-token-queue",
  });
}, 180_000);

afterAll(async () => {
  await server?.stop();
}, 120_000);

async function mintChildToken() {
  const plaintext = `tr_wgt_${randomBytes(20).toString("hex")}`;
  await server.prisma.workerGroupToken.create({
    data: {
      tokenHash: createHash("sha256").update(plaintext).digest("hex"),
      workerGroupId: WORKER_GROUP_ID,
    },
  });
  return plaintext;
}

function post(token: string, path: string, body: unknown) {
  return server.webapp.fetch(path, {
    method: "POST",
    headers: { ...workerHeaders(fixtures, "child-instance"), Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const heartbeatBody = {
  cpu: { used: 0, available: 1 },
  memory: { used: 0, available: 1 },
  tasks: [],
};

describe("child worker tokens", () => {
  it("can do worker actions but cannot dequeue", async () => {
    const child = await mintChildToken();

    expect((await post(child, "/engine/v1/worker-actions/heartbeat", heartbeatBody)).status).toBe(
      200
    );
    expect((await post(child, "/engine/v1/worker-actions/dequeue", {})).status).toBe(403);

    expect(
      (await post(fixtures.workerGroupToken, "/engine/v1/worker-actions/dequeue", {})).status
    ).toBe(200);
  }, 180_000);
});
