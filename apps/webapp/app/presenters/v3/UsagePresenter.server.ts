import { Prisma } from "@trigger.dev/database";
import { sqlDatabaseSchema } from "~/db.server";
import { BasePresenter } from "./basePresenter.server";
import { getUsage, getUsageSeries } from "~/services/platform.v3.server";
import { createTimeSeriesData } from "~/utils/graphs";

type Options = {
  organizationId: string;
};

export type TaskUsageItem = {
  taskIdentifier: string;
  runCount: number;
  averageDuration: number;
  averageCost: number;
  totalDuration: number;
  totalCost: number;
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

    //usage data from the platform
    const past30Days = getUsageSeries(organizationId, {
      from: thirtyDaysAgo,
      to: endOfToday,
      window: "DAY",
    }).then((data) => {
      return createTimeSeriesData({
        startDate: thirtyDaysAgo,
        endDate: endOfToday,
        window: "DAY",
        data: data
          ? data.data.map((period) => ({
              date: new Date(period.windowStart),
              value: period.value,
            }))
          : [],
      }).map((period) => ({
        date: period.date.toISOString(),
        dollars: (period.value ?? 0) / 100,
      }));
    });

    //usage by task
    const tasks = this._replica.$queryRaw<TaskUsageItem[]>`
    SELECT
      tr."taskIdentifier",
      COUNT(*) AS "runCount",
      AVG(tr."usageDurationMs") AS "averageDuration",
      SUM(tr."usageDurationMs") AS "totalDuration",
      AVG(tr."costInCents") / 100.0 AS "averageCost",
      SUM(tr."costInCents") / 100.0 AS "totalCost"
  FROM
      ${sqlDatabaseSchema}."TaskRun" tr
      JOIN ${sqlDatabaseSchema}."Project" pr ON pr.id = tr."projectId"
      JOIN ${sqlDatabaseSchema}."Organization" org ON org.id = pr."organizationId"
  WHERE
      tr."createdAt" > ${thirtyDaysAgo}
      AND tr."createdAt" < ${endOfToday}
      AND org.id = ${organizationId}
  GROUP BY
      tr."taskIdentifier"
  ORDER BY
  "totalCost" DESC;
  `.then((data) => {
      return data.map((item) => ({
        taskIdentifier: item.taskIdentifier,
        runCount: Number(item.runCount),
        averageDuration: Number(item.averageDuration),
        averageCost: Number(item.averageCost),
        totalDuration: Number(item.totalDuration),
        totalCost: Number(item.totalCost),
      }));
    });

    //month-to-date usage data with projection
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
      tasks,
    };
  }
}
