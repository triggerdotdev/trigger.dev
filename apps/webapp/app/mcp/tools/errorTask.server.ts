import type { ClickHouse } from "@internal/clickhouse";
import type { ReadLimit } from "~/presenters/v3/clickhouseReadLimit";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { capText, untrusted } from "./format/logFields";

const SHOWN_TASKS = 10;

type Scope = { organizationId: string; projectId: string; environmentId: string };

export type ErrorTaskChoice = { task: string } | { notFound: true } | { ambiguous: string };

export const fingerprintOf = (errorId: string) => errorId.slice("error_".length);

/** The tasks that have an error group with this fingerprint, by name, up to `limit`. */
async function errorTaskIdentifiers(
  clickhouse: ClickHouse,
  scope: Scope,
  fingerprint: string,
  limit: number,
  readLimit?: ReadLimit
): Promise<string[]> {
  const queryBuilder = clickhouse.errors.listQueryBuilder(
    readLimit ? { settings: { max_execution_time: readLimit.maxExecutionSeconds } } : undefined
  );
  queryBuilder.where("organization_id = {organizationId: String}", {
    organizationId: scope.organizationId,
  });
  queryBuilder.where("project_id = {projectId: String}", { projectId: scope.projectId });
  queryBuilder.where("environment_id = {environmentId: String}", {
    environmentId: scope.environmentId,
  });
  queryBuilder.where("error_fingerprint = {fingerprint: String}", { fingerprint });
  queryBuilder.groupBy("error_fingerprint, task_identifier");
  queryBuilder.orderBy("task_identifier");
  queryBuilder.limit(limit);

  const [queryError, records] = await queryBuilder.execute();
  if (queryError) throw queryError;
  return (records ?? []).map((record) => record.task_identifier);
}

export async function chooseErrorTask(
  scope: Scope,
  errorId: string,
  taskIdentifier: string | undefined,
  readLimit?: ReadLimit
): Promise<ErrorTaskChoice> {
  if (taskIdentifier !== undefined) return { task: taskIdentifier };

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    scope.organizationId,
    "logs"
  );
  const tasks = await errorTaskIdentifiers(
    clickhouse,
    scope,
    fingerprintOf(errorId),
    SHOWN_TASKS + 1,
    readLimit
  );
  if (tasks.length === 0) return { notFound: true };
  if (tasks.length === 1) return { task: tasks[0]! };

  const shown = tasks
    .slice(0, SHOWN_TASKS)
    .map((task) => capText(task, 200))
    .join(", ");
  const more = tasks.length > SHOWN_TASKS ? " and more" : "";
  return {
    ambiguous: `Error ${errorId} occurs in more than one task: ${untrusted(shown, "error-tasks", 4_000)}${more}. Pass taskIdentifier to choose one`,
  };
}
