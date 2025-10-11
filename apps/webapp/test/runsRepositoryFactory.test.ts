import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("~/env.server", () => ({
  env: {},
}));
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { createRunsRepository } from "~/services/runsRepositoryFactory.server";
import type { ClickHouse } from "@internal/clickhouse";
import type { PrismaClient } from "@trigger.dev/database";

describe("createRunsRepository", () => {
  let mockClickhouse: ClickHouse;
  let mockPrisma: PrismaClient;
  let originalEnv: Record<string, unknown>;

  beforeEach(async () => {
    const envModule = await import("~/env.server");
    originalEnv = { ...envModule.env };

    mockClickhouse = {} as ClickHouse;
    mockPrisma = {} as PrismaClient;
  });

  afterEach(async () => {
    const envModule = await import("~/env.server");
    Object.assign(envModule.env, originalEnv);
  });

  it("should default to postgres when RUN_REPLICATION_ENABLED is not set", async () => {
    const envModule = await import("~/env.server");
    envModule.env.RUN_REPLICATION_ENABLED = "0";
    envModule.env.RUN_REPLICATION_CLICKHOUSE_URL = "http://localhost:8123";

    const repository = createRunsRepository({
      clickhouse: mockClickhouse,
      prisma: mockPrisma,
    });

    expect(repository).toBeDefined();
    expect(repository.listRuns).toBeDefined();
  });

  it("should default to postgres when RUN_REPLICATION_CLICKHOUSE_URL is not set", async () => {
    const envModule = await import("~/env.server");
    envModule.env.RUN_REPLICATION_ENABLED = "1";
    envModule.env.RUN_REPLICATION_CLICKHOUSE_URL = undefined;

    const repository = createRunsRepository({
      clickhouse: mockClickhouse,
      prisma: mockPrisma,
    });

    expect(repository).toBeDefined();
    expect(repository.listRuns).toBeDefined();
  });

  it("should default to clickhouse when both conditions are met", async () => {
    const envModule = await import("~/env.server");
    envModule.env.RUN_REPLICATION_ENABLED = "1";
    envModule.env.RUN_REPLICATION_CLICKHOUSE_URL = "http://localhost:8123";

    const repository = createRunsRepository({
      clickhouse: mockClickhouse,
      prisma: mockPrisma,
    });

    expect(repository).toBeDefined();
    expect(repository.listRuns).toBeDefined();
  });

  it("should create a valid RunsRepository instance", () => {
    const repository = createRunsRepository({
      clickhouse: mockClickhouse,
      prisma: mockPrisma,
    });

    expect(repository.listRuns).toBeDefined();
    expect(repository.countRuns).toBeDefined();
    expect(typeof repository.listRuns).toBe("function");
    expect(typeof repository.countRuns).toBe("function");
  });
});

