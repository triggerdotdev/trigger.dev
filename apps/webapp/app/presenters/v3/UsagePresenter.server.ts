import { Prisma } from "@trigger.dev/database";
import { sqlDatabaseSchema } from "~/db.server";
import { BasePresenter } from "./basePresenter.server";
import { getUsage, getUsageSeries } from "~/services/platform.v3.server";
import { createTimeSeriesData } from "~/utils/graphs";

type Options = {
  organizationId: string;
};

export class UsagePresenter extends BasePresenter {
  public async call({ organizationId }: Options) {
    //periods
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setDate(endOfToday.getDate() + 1);
    endOfToday.setHours(23, 59, 59, 999);

    const past30Days = getUsageSeries(organizationId, {
      from: thirtyDaysAgo,
      to: endOfToday,
      window: "DAY",
    }).then((data) => {
      if (!data) return [];
      return createTimeSeriesData({
        startDate: thirtyDaysAgo,
        endDate: endOfToday,
        window: "DAY",
        data:
          data.data.map((period) => ({
            date: new Date(period.windowStart),
            value: period.value,
          })) ?? [],
      }).map((period) => ({
        date: period.date.toISOString(),
        dollars: (period.value ?? 0) / 100,
      }));
    });

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const usage = getUsage(organizationId, { from: startOfMonth, to: endOfMonth }).then((data) => {
      const current = (data?.cents ?? 0) / 100;
      const percentageThroughMonth = new Date().getDate() / endOfMonth.getDate();
      return {
        current: current,
        projected: current / percentageThroughMonth,
      };
    });

    return {
      past30Days,
      usage,
    };
  }
}
