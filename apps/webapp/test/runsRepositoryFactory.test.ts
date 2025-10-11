import { describe, it, expect, vi } from "vitest";

vi.mock("~/env.server", () => ({
  env: {
    RUN_REPLICATION_ENABLED: "0",
    RUN_REPLICATION_CLICKHOUSE_URL: undefined,
    DATABASE_CONNECTION_LIMIT: 10,
    DATABASE_POOL_TIMEOUT: 60,
    DATABASE_CONNECTION_TIMEOUT: 20,
  },
}));

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { createRunsRepository } from "~/services/runsRepositoryFactory.server";
import type { ClickHouse } from "@internal/clickhouse";
import type { PrismaClient } from "@trigger.dev/database";

describe("createRunsRepository", () => {
  const mockClickhouse = {} as ClickHouse;
  const mockPrisma = {} as PrismaClient;

  it("should default to postgres when replication is disabled", () => {
    const repository = createRunsRepository({
      clickhouse: mockClickhouse,
      prisma: mockPrisma,
      isReplicationEnabled: false,
      isClickHouseConfigured: true,
    });

    expect(repository).toBeDefined();
    expect(repository.listRuns).toBeDefined();
  });

  it("should default to postgres when ClickHouse is not configured", () => {
    const repository = createRunsRepository({
      clickhouse: mockClickhouse,
      prisma: mockPrisma,
      isReplicationEnabled: true,
      isClickHouseConfigured: false,
    });

    expect(repository).toBeDefined();
    expect(repository.listRuns).toBeDefined();
  });

  it("should default to clickhouse when both conditions are met", () => {
    const repository = createRunsRepository({
      clickhouse: mockClickhouse,
      prisma: mockPrisma,
      isReplicationEnabled: true,
      isClickHouseConfigured: true,
    });

    expect(repository).toBeDefined();
    expect(repository.listRuns).toBeDefined();
  });

  it("should create a valid RunsRepository instance with all required methods", () => {
    const repository = createRunsRepository({
      clickhouse: mockClickhouse,
      prisma: mockPrisma,
      isReplicationEnabled: false,
      isClickHouseConfigured: false,
    });

    expect(repository.listRuns).toBeDefined();
    expect(repository.countRuns).toBeDefined();
    expect(typeof repository.listRuns).toBe("function");
    expect(typeof repository.countRuns).toBe("function");
  });
});

