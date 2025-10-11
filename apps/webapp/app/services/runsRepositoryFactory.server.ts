import type { ClickHouse } from "@internal/clickhouse";
import type { PrismaClient } from "@trigger.dev/database";
import { env } from "~/env.server";
import { RunsRepository } from "./runsRepository/runsRepository.server";

export function createRunsRepository(options: {
  clickhouse: ClickHouse;
  prisma: PrismaClient;
}): RunsRepository {
  const isReplicationEnabled = env.RUN_REPLICATION_ENABLED === "1";
  const isClickHouseConfigured = !!env.RUN_REPLICATION_CLICKHOUSE_URL;
  
  const defaultRepository = isReplicationEnabled && isClickHouseConfigured 
    ? "clickhouse" 
    : "postgres";

  return new RunsRepository({
    ...options,
    defaultRepository,
  });
}

