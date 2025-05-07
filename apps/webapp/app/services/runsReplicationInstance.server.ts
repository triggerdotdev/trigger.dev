import { ClickHouse } from "@internal/clickhouse";
import { RunsReplicationService } from "./runsReplicationService.server";
import { singleton } from "~/utils/singleton";
import invariant from "tiny-invariant";
import { env } from "~/env.server";
import { metricsRegister } from "~/metrics.server";

export const runsReplicationInstance = singleton(
  "runsReplicationInstance",
  initializeRunsReplicationInstance
);

function initializeRunsReplicationInstance() {
  const { DATABASE_URL } = process.env;
  invariant(typeof DATABASE_URL === "string", "DATABASE_URL env var not set");

  const clickhouse = ClickHouse.fromEnv();

  const service = new RunsReplicationService({
    clickhouse: clickhouse,
    pgConnectionUrl: DATABASE_URL,
    serviceName: "runs-replication",
    slotName: "task_runs_to_clickhouse_v1",
    publicationName: "task_runs_to_clickhouse_v1_publication",
    redisOptions: {
      keyPrefix: "runs-replication:",
      port: env.RUN_REPLICATION_REDIS_PORT ?? undefined,
      host: env.RUN_REPLICATION_REDIS_HOST ?? undefined,
      username: env.RUN_REPLICATION_REDIS_USERNAME ?? undefined,
      password: env.RUN_REPLICATION_REDIS_PASSWORD ?? undefined,
      enableAutoPipelining: true,
      ...(env.RUN_REPLICATION_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
    metricsRegister: metricsRegister,
  });

  return service;
}
