import {
  type PendingVersionRunIdLookup,
  type PendingVersionRunIdLookupOptions,
  type PendingVersionRunIdLookupResult,
} from "@internal/run-engine";
import { Logger } from "@trigger.dev/core/logger";
import type { ClickhouseFactory } from "~/services/clickhouse/clickhouseFactory.server";

export type ClickhousePendingVersionLookupOptions = {
  clickhouseFactory: ClickhouseFactory;
  logger: Logger;
};

/**
 * ClickHouse-backed lookup for `PENDING_VERSION` TaskRun ids.
 *
 * Resolves the ClickHouse client per call via the
 * {@link ClickhouseFactory}, which honors per-organization data-store
 * routing (HIPAA / data-sovereignty customers get their own instance,
 * everyone else lands on the shared `engine` client configured by
 * `RUN_ENGINE_CLICKHOUSE_*` env vars).
 *
 * Best-effort by design: replication lag against `task_runs_v2` can
 * produce stale candidates. The run-engine consumer re-validates every
 * id against Postgres by primary key with a `status = 'PENDING_VERSION'`
 * guard before any mutation, so stale ids are dropped at the source of
 * truth. On ClickHouse error we log and return an empty result; the
 * pending-version re-enqueue tail loop retries on the next event.
 */
export class ClickhousePendingVersionLookup implements PendingVersionRunIdLookup {
  readonly name = "clickhouse";

  constructor(private readonly opts: ClickhousePendingVersionLookupOptions) {}

  async lookupPendingVersionRunIds(
    options: PendingVersionRunIdLookupOptions
  ): Promise<PendingVersionRunIdLookupResult> {
    // Empty IN-lists would be a no-op; bail before issuing the query.
    if (options.taskIdentifiers.length === 0 || options.queues.length === 0) {
      return { runIds: [] };
    }

    let clickhouse;
    try {
      clickhouse = await this.opts.clickhouseFactory.getClickhouseForOrganization(
        options.organizationId,
        "engine"
      );
    } catch (error) {
      // Factory resolution failures usually mean a real configuration
      // problem (registry misload, missing data store, ClientType mismatch).
      // These are not transient — log at error so ops sees them in dashboards
      // and incident hooks. Query-level errors below stay at warn because
      // those are expected to be transient.
      this.opts.logger.error("ClickhousePendingVersionLookup factory resolution failed", {
        error,
        organizationId: options.organizationId,
      });
      return { runIds: [] };
    }

    const builder = clickhouse.taskRuns
      .pendingVersionIdsQueryBuilder()
      // `organization_id` MUST be the leading filter — it is the leading
      // sort-key column on `task_runs_v2` and the only thing that prunes
      // granules cheaply on a multi-tenant table.
      .where("organization_id = {organizationId: String}", {
        organizationId: options.organizationId,
      })
      .where("project_id = {projectId: String}", { projectId: options.projectId })
      .where("environment_id = {environmentId: String}", {
        environmentId: options.environmentId,
      })
      .where("status = 'PENDING_VERSION'")
      .where("task_identifier IN {taskIdentifiers: Array(String)}", {
        taskIdentifiers: options.taskIdentifiers,
      })
      .where("queue IN {queues: Array(String)}", { queues: options.queues })
      .where("_is_deleted = 0")
      .orderBy("created_at ASC")
      .limit(options.limit);

    const [queryError, rows] = await builder.execute();

    if (queryError) {
      this.opts.logger.warn("ClickhousePendingVersionLookup query failed", {
        error: queryError,
        organizationId: options.organizationId,
        projectId: options.projectId,
        environmentId: options.environmentId,
      });
      return { runIds: [] };
    }

    return { runIds: rows.map((row) => row.run_id) };
  }
}
