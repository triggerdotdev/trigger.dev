import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agent reads a queue's live row — paused, depth, limit — through the environment JWT it
 * exchanges its delegated token for. Metrics already answer that JWT; without the same on the
 * retrieve route the agent got a 401, which reaches the model as absent data and had it
 * telling users a queue of thousands of runs did not exist.
 *
 * These drive the real loader with a real signed environment JWT: the route builder
 * authenticates it, compiles its scopes into an ability, and gates on `read:queues`.
 */

const ENVIRONMENT_ID = "env_1234";
const API_KEY = "tr_dev_abcdefghijklmnop";

const environment = {
  id: ENVIRONMENT_ID,
  type: "DEVELOPMENT",
  slug: "dev",
  branchName: null,
  apiKey: API_KEY,
  organizationId: "org_1",
  projectId: "proj_1",
  archivedAt: null,
  concurrencyLimitBurstFactor: 1,
  maximumConcurrencyLimit: 10,
  project: { id: "proj_1", externalRef: "proj_ref", deletedAt: null },
  organization: { id: "org_1" },
  orgMember: null,
  parentEnvironment: null,
};

const queueRow = {
  id: "tq_1",
  friendlyId: "queue_1234",
  name: "task/my-task",
  type: "VIRTUAL",
  runtimeEnvironmentId: ENVIRONMENT_ID,
  paused: true,
  concurrencyLimit: 5,
  concurrencyLimitBase: 5,
  concurrencyLimitOverriddenAt: null,
  concurrencyLimitOverriddenBy: null,
  concurrencyLimitOverridePercent: null,
};

const mocks = vi.hoisted(() => ({
  runtimeEnvironmentFindFirst: vi.fn(),
  taskQueueFindFirst: vi.fn(),
  revokedApiKeyFindMany: vi.fn(),
}));

vi.mock("~/db.server", () => {
  const client = {
    runtimeEnvironment: { findFirst: mocks.runtimeEnvironmentFindFirst },
    taskQueue: { findFirst: mocks.taskQueueFindFirst },
    revokedApiKey: { findMany: mocks.revokedApiKeyFindMany, findFirst: async () => null },
  };
  return { prisma: client, $replica: client };
});
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock("~/v3/engineVersion.server", () => ({ determineEngineVersion: async () => "V2" }));
vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    lengthOfQueues: async () => ({ "task/my-task": 1234 }),
    currentConcurrencyOfQueues: async () => ({ "task/my-task": 2 }),
  },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/v3/services/worker/workerGroupTokenService.server", () => ({
  WorkerGroupTokenService: class {},
}));

import { loader } from "~/routes/api.v1.queues.$queueParam";

/** The claims the env-JWT exchange mints (api.v1.projects.$projectRef.$env.jwt.ts). */
function mintEnvJwt(scopes: string[]) {
  return generateJWT({
    secretKey: API_KEY,
    payload: {
      sub: ENVIRONMENT_ID,
      pub: true,
      scopes,
      act: { sub: "usr_1", client: "dashboard-agent" },
    },
    expirationTime: "1h",
  });
}

async function retrieveQueue(token: string) {
  const response = await loader({
    request: new Request("https://api.trigger.dev/api/v1/queues/my-task?type=task", {
      headers: { Authorization: `Bearer ${token}` },
    }),
    params: { queueParam: "my-task" },
    context: {},
  } as any);
  return { status: response.status, body: await response.json() };
}

describe("queue retrieve through an environment JWT", () => {
  beforeEach(() => {
    // Only the JWT's own `sub` lookup resolves — a bearer read as an API key finds nothing.
    mocks.runtimeEnvironmentFindFirst
      .mockReset()
      .mockImplementation(async ({ where }: any) =>
        where?.id === ENVIRONMENT_ID ? environment : null
      );
    mocks.taskQueueFindFirst.mockReset().mockResolvedValue(queueRow);
    mocks.revokedApiKeyFindMany.mockReset().mockResolvedValue([]);
  });

  it("answers a JWT carrying read:queues with the queue's live row", async () => {
    const result = await retrieveQueue(await mintEnvJwt(["read:runs", "read:queues"]));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      id: "queue_1234",
      name: "my-task",
      paused: true,
      queued: 1234,
    });
  });

  it("refuses a JWT without it — widening who may ask must not widen what they may read", async () => {
    const result = await retrieveQueue(await mintEnvJwt(["read:runs", "read:query"]));

    expect(result.status).toBe(403);
    expect(mocks.taskQueueFindFirst).not.toHaveBeenCalled();
  });
});
