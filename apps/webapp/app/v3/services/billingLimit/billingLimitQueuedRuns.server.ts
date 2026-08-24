import type { ClickHouse } from "@internal/clickhouse";
import type { PrismaClient, TaskRunStatus } from "@trigger.dev/database";
import { QUEUED_STATUSES, RUNNING_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { prisma } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import {
  BILLABLE_ENVIRONMENT_TYPES,
  BILLING_LIMIT_QUEUED_COUNT_MAX_EXECUTION_S,
} from "./billingLimitConstants";

import { boundedIn } from "@trigger.dev/database";
export type BillableEnvironmentRef = {
  id: string;
  projectId: string;
};

/**
 * Environments whose runs a billing limit must act on. Archived branches stay included:
 * archiving is a soft update that cancels nothing, so an archived branch can still hold
 * executing runs that enforcement has to cancel.
 */
export async function getBillableEnvironmentsForBillingLimit(
  organizationId: string,
  prismaClient: PrismaClient = prisma
): Promise<BillableEnvironmentRef[]> {
  return prismaClient.runtimeEnvironment.findMany({
    where: {
      organizationId,
      type: { in: boundedIn([...BILLABLE_ENVIRONMENT_TYPES]) },
    },
    select: {
      id: true,
      projectId: true,
    },
  });
}

export async function createBillingLimitRunsRepository(organizationId: string) {
  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    organizationId,
    "standard"
  );

  return new RunsRepository({
    clickhouse,
    prisma: prisma as PrismaClient,
  });
}

export async function countQueuedRunsForBillableEnvironment(
  runsRepository: RunsRepository,
  organizationId: string,
  environment: BillableEnvironmentRef
): Promise<number> {
  return countRunsForBillableEnvironment(runsRepository, organizationId, environment, [
    ...QUEUED_STATUSES,
  ]);
}

export async function countInProgressRunsForBillableEnvironment(
  runsRepository: RunsRepository,
  organizationId: string,
  environment: BillableEnvironmentRef
): Promise<number> {
  return countRunsForBillableEnvironment(runsRepository, organizationId, environment, [
    ...RUNNING_STATUSES,
  ]);
}

async function countRunsForBillableEnvironment(
  runsRepository: RunsRepository,
  organizationId: string,
  environment: BillableEnvironmentRef,
  statuses: TaskRunStatus[]
): Promise<number> {
  return runsRepository.countRuns({
    organizationId,
    projectId: environment.projectId,
    environmentId: environment.id,
    statuses,
  });
}

/**
 * Same table and statuses as BillingLimitBulkCancelService's per-environment counts, but a
 * single org-level ClickHouse query filtered on environment_type. Deliberately NOT a
 * per-environment loop: an org can have thousands of (mostly archived) preview environments,
 * and sequential per-env counts hold the billing-limits loader open past the edge timeout.
 * The count is display-only, so a server-side execution cap beats an unbounded query.
 */
export async function countBillableQueuedRunsForOrganization(
  organizationId: string,
  clickhouse?: ClickHouse
): Promise<number> {
  const client =
    clickhouse ??
    (await clickhouseFactory.getClickhouseForOrganization(organizationId, "standard"));

  const queryBuilder = client.taskRuns.countQueryBuilder({
    settings: { max_execution_time: BILLING_LIMIT_QUEUED_COUNT_MAX_EXECUTION_S },
  });

  queryBuilder
    .where("organization_id = {organizationId: String}", { organizationId })
    .where("environment_type IN {environmentTypes: Array(String)}", {
      environmentTypes: [...BILLABLE_ENVIRONMENT_TYPES],
    })
    .where("status IN {statuses: Array(String)}", { statuses: [...QUEUED_STATUSES] });

  const [queryError, result] = await queryBuilder.execute();

  if (queryError) {
    throw queryError;
  }

  return result[0]?.count ?? 0;
}
