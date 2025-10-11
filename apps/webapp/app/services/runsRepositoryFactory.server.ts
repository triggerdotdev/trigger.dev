import type { ClickHouse } from "@internal/clickhouse";
import type { PrismaClient } from "@trigger.dev/database";
import { env } from "~/env.server";
import { RunsRepository } from "./runsRepository/runsRepository.server";

export function createRunsRepository(options: {
  clickhouse: ClickHouse;
  prisma: PrismaClient;
  isReplicationEnabled?: boolean;
  isClickHouseConfigured?: boolean;
}): RunsRepository {
  const isReplicationEnabled = options.isReplicationEnabled ?? env.RUN_REPLICATION_ENABLED === "1";
  const isClickHouseConfigured = options.isClickHouseConfigured ?? !!env.RUN_REPLICATION_CLICKHOUSE_URL;
  
  const defaultRepository = isReplicationEnabled && isClickHouseConfigured 
    ? "clickhouse" 
    : "postgres";

  return new RunsRepository({
    clickhouse: options.clickhouse,
    prisma: options.prisma,
    defaultRepository,
  });
}

