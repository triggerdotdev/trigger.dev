import { PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { BillingService } from "../services/billing.server";

export class OrgBillingPlanPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ slug, isManagedCloud }: { slug: string; isManagedCloud: boolean }) {
    const billingPresenter = new BillingService(isManagedCloud);
    const plans = await billingPresenter.getPlans();

    if (plans === undefined) {
      return;
    }

    const organization = await this.#prismaClient.organization.findFirst({
      where: {
        slug,
      },
    });

    if (!organization) {
      return;
    }

    const maxConcurrency = await this.#prismaClient.$queryRaw<
      { organization_id: string; max_concurrent_runs: BigInt }[]
    >`WITH events AS (
      SELECT
        re.event_time,
        re.organization_id,
        re.event_type,
        SUM(re.event_type) OVER (PARTITION BY re.organization_id ORDER BY re.event_time) AS running_total
      FROM
        triggerdotdev_events.run_executions re
      WHERE
        re.organization_id = ${organization.id}
        AND re.event_time >= DATE_TRUNC('month',
        CURRENT_DATE)
    )
    SELECT
      organization_id, MAX(running_total) AS max_concurrent_runs
    FROM
      events
    GROUP BY
      organization_id;`;

    return {
      plans,
      maxConcurrency:
        maxConcurrency.at(0) !== undefined
          ? Number(maxConcurrency[0].max_concurrent_runs)
          : undefined,
    };
  }
}
