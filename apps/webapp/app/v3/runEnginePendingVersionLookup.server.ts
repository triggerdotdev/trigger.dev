import { type PendingVersionRunIdLookup } from "@internal/run-engine";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { ClickhousePendingVersionLookup } from "./services/clickhousePendingVersionLookup.server";

/**
 * Lookup used by `@internal/run-engine`'s `PendingVersionSystem` to find
 * `PENDING_VERSION` TaskRun ids via ClickHouse, removing the need for
 * Postgres index #13 (`TaskRun_status_runtimeEnvironmentId_createdAt_id_idx`).
 *
 * Resolves the ClickHouse client per call via {@link clickhouseFactory}
 * using the `"engine"` client type, configured by `RUN_ENGINE_CLICKHOUSE_*`
 * env vars and routed per-organization for customers with HIPAA / data
 * sovereignty data stores.
 */
export const runEnginePendingVersionLookup = singleton(
  "runEnginePendingVersionLookup",
  initializeRunEnginePendingVersionLookup
);

function initializeRunEnginePendingVersionLookup(): PendingVersionRunIdLookup {
  return new ClickhousePendingVersionLookup({ clickhouseFactory, logger });
}
