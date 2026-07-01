import type { PrismaClient,TaskRunStatus } from "@trigger.dev/database";
import { QUEUED_STATUSES,RUNNING_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { prisma } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { BILLABLE_ENVIRONMENT_TYPES } from "./billingLimitConstants";

export type BillableEnvironmentRef = {
  id: string;
  projectId: string;
};

export async function getBillableEnvironmentsForBillingLimit(
  organizationId: string,
  prismaClient: PrismaClient = prisma
): Promise<BillableEnvironmentRef[]> {
  return prismaClient.runtimeEnvironment.findMany({
    where: {
      organizationId,
      type: { in: [...BILLABLE_ENVIRONMENT_TYPES] },
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

/** Same source as BillingLimitBulkCancelService — ClickHouse countRuns(QUEUED_STATUSES). */
export async function countBillableQueuedRunsForOrganization(
  organizationId: string
): Promise<number> {
  const environments = await getBillableEnvironmentsForBillingLimit(organizationId);

  if (environments.length === 0) {
    return 0;
  }

  const runsRepository = await createBillingLimitRunsRepository(organizationId);

  let total = 0;

  for (const environment of environments) {
    total += await countQueuedRunsForBillableEnvironment(
      runsRepository,
      organizationId,
      environment
    );
  }

  return total;
}
