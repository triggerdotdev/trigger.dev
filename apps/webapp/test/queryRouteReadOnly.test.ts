import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The query API is read-only, and the grammar is what enforces it. A parser test alone would
 * stay green if the route ever compiled agent SQL somewhere else, so these drive the real route
 * with a real signed environment JWT and stub only the ClickHouse client. A write must be
 * refused before anything reaches ClickHouse.
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
  concurrencyLimitBurstFactor: { toNumber: () => 1 },
  maximumConcurrencyLimit: 10,
  project: { id: "proj_1", externalRef: "proj_ref", deletedAt: null },
  organization: { id: "org_1" },
  orgMember: null,
  parentEnvironment: null,
};

const mocks = vi.hoisted(() => ({
  runtimeEnvironmentFindFirst: vi.fn(),
  queryWithStats: vi.fn(),
  customerQueryCreate: vi.fn(),
  concurrencyAcquire: vi.fn(),
}));

vi.mock("~/db.server", () => {
  const client = {
    runtimeEnvironment: {
      findFirst: mocks.runtimeEnvironmentFindFirst,
      findMany: async () => [],
    },
    revokedApiKey: { findMany: async () => [], findFirst: async () => null },
    project: { findMany: async () => [] },
    customerQuery: { findFirst: async () => null, create: mocks.customerQueryCreate },
  };
  return { prisma: client, $replica: client };
});
vi.mock("~/env.server", () => ({
  env: {
    SESSION_SECRET: "test-session-secret",
    QUERY_CLICKHOUSE_MAX_EXECUTION_TIME: "30",
    QUERY_CLICKHOUSE_MAX_MEMORY_USAGE: 1000000,
    QUERY_CLICKHOUSE_MAX_AST_ELEMENTS: 50000,
    QUERY_CLICKHOUSE_MAX_EXPANDED_AST_ELEMENTS: 500000,
    QUERY_CLICKHOUSE_MAX_BYTES_BEFORE_EXTERNAL_GROUP_BY: 1000000,
    QUERY_CLICKHOUSE_MAX_RETURNED_ROWS: 1000,
  },
}));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: {
    getClickhouseForOrganization: async () => ({
      reader: { queryWithStats: mocks.queryWithStats },
    }),
  },
}));
vi.mock("~/services/platform.v3.server", () => ({ getLimit: async () => 30 }));
vi.mock("~/services/queryConcurrencyLimiter.server", () => ({
  queryConcurrencyLimiter: {
    acquire: mocks.concurrencyAcquire,
    release: async () => {},
  },
  DEFAULT_ORG_CONCURRENCY_LIMIT: 10,
  GLOBAL_CONCURRENCY_LIMIT: 100,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/v3/services/worker/workerGroupTokenService.server", () => ({
  WorkerGroupTokenService: class {},
}));
vi.mock("~/v3/services/common.server", () => ({ ServiceValidationError: class extends Error {} }));
vi.mock("@internal/run-engine", () => ({ EngineServiceValidationError: class extends Error {} }));

import { action } from "~/routes/api.v1.query";
import { executeQuery } from "~/services/queryService.server";

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

async function runQuery(query: string): Promise<{ status: number; body: any }> {
  const jwt = await mintEnvJwt(["read:query"]);
  const response = await action({
    request: new Request("https://api.trigger.dev/api/v1/query", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }),
    params: {},
    context: {},
  } as any);
  return { status: response.status, body: await response.json() };
}

describe("the query API route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeEnvironmentFindFirst.mockResolvedValue(environment);
    mocks.customerQueryCreate.mockResolvedValue({ id: "cq_1" });
    mocks.concurrencyAcquire.mockResolvedValue({ success: true });
    mocks.queryWithStats.mockReturnValue(async () => [null, { rows: [], stats: {} }]);
  });

  // Pins the seam the two refusals assert against: a read really does reach ClickHouse here,
  // so `not.toHaveBeenCalled()` below means refused, not unreachable.
  it("runs a read against ClickHouse", async () => {
    const result = await runQuery("SELECT count() FROM runs");

    expect(result.status).toBe(200);
    expect(mocks.queryWithStats).toHaveBeenCalled();
  });

  it("refuses a write smuggled in as a second statement", async () => {
    const result = await runQuery("SELECT 1 FROM runs; DROP TABLE runs");

    expect(result.status).toBe(400);
    expect(mocks.queryWithStats).not.toHaveBeenCalled();
  });

  it("refuses a mutating statement", async () => {
    const result = await runQuery("INSERT INTO runs (task_identifier) VALUES ('x')");

    expect(result.status).toBe(400);
    expect(mocks.queryWithStats).not.toHaveBeenCalled();
  });

  // A busy service is not a bad query: 400 would tell a caller to rewrite a query that was fine.
  it("answers a concurrency rejection with 429", async () => {
    mocks.concurrencyAcquire.mockResolvedValue({ success: false, reason: "key_limit" });

    const result = await runQuery("SELECT count() FROM runs");

    expect(result.status).toBe(429);
    expect(result.body.error).toContain("try again later");
  });
});

describe("the query service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.concurrencyAcquire.mockResolvedValue({ success: true });
    mocks.queryWithStats.mockReturnValue(async () => [null, { rows: [], stats: {} }]);
  });

  it("keeps ClickHouse read-only when a caller overrides the settings", async () => {
    await executeQuery({
      name: "test-query",
      query: "SELECT count() FROM runs",
      scope: "environment",
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: ENVIRONMENT_ID,
      clickhouseSettings: { readonly: "0" },
    } as any);

    expect(mocks.queryWithStats).toHaveBeenCalled();
    expect(mocks.queryWithStats.mock.calls[0][0].settings.readonly).toBe("1");
  });
});
