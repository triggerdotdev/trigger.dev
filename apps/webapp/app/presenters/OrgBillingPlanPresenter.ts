import { BillingService } from "../services/billing.v2.server";
import { BasePresenter } from "./v3/basePresenter.server";

export class OrgBillingPlanPresenter extends BasePresenter {
  public async call({ slug, isManagedCloud }: { slug: string; isManagedCloud: boolean }) {
    const billingPresenter = new BillingService(isManagedCloud);
    const plans = await billingPresenter.getPlans();

    if (plans === undefined) {
      return;
    }

    const organization = await this._replica.organization.findFirst({
      where: {
        slug,
      },
    });

    if (!organization) {
      return;
    }

    const maxConcurrency = await this._replica.$queryRaw<
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
