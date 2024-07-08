import { sqlDatabaseSchema } from "~/db.server";
import { env } from "~/env.server";
import { getUsage, getUsageSeries } from "~/services/platform.v3.server";
import { createTimeSeriesData } from "~/utils/graphs";
import { BasePresenter } from "./basePresenter.server";
import { start } from "@popperjs/core";

type Options = {
  organizationId: string;
  startDate: Date;
};

export type TaskUsageItem = {
  taskIdentifier: string;
  runCount: number;
  averageDuration: number;
  averageCost: number;
  totalDuration: number;
  totalCost: number;
  totalBaseCost: number;
};

export type UsageSeriesData = {
  date: string;
  dollars: number;
}[];

export class UsagePresenter extends BasePresenter {
  public async call({ organizationId, startDate }: Options) {
    //month period
    const startOfMonth = new Date(startDate);
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const endOfMonth = new Date(
      startOfMonth.getFullYear(),
      startOfMonth.getMonth() + 1,
      0,
      23,
      59,
      59,
      999
    );

    //usage data from the platform
    const past30Days = getUsageSeries(organizationId, {
      from: startOfMonth,
      to: endOfMonth,
      window: "DAY",
    }).then((data) => {
      return createTimeSeriesData({
        startDate: startOfMonth,
        endDate: endOfMonth,
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
      SUM(tr."costInCents") / 100.0 AS "totalCost",
      SUM(tr."baseCostInCents") / 100.0 AS "totalBaseCost"
  FROM
      ${sqlDatabaseSchema}."TaskRun" tr
      JOIN ${sqlDatabaseSchema}."Project" pr ON pr.id = tr."projectId"
      JOIN ${sqlDatabaseSchema}."Organization" org ON org.id = pr."organizationId"
  WHERE
      tr."createdAt" > ${startOfMonth}
      AND tr."createdAt" < ${endOfMonth}
      AND org.id = ${organizationId}
  GROUP BY
      tr."taskIdentifier";
  `.then((data) => {
      return data
        .map((item) => ({
          taskIdentifier: item.taskIdentifier,
          runCount: Number(item.runCount),
          averageDuration: Number(item.averageDuration),
          averageCost: Number(item.averageCost) + env.CENTS_PER_RUN / 100,
          totalDuration: Number(item.totalDuration),
          totalCost: Number(item.totalCost + item.totalBaseCost),
        }))
        .sort((a, b) => b.totalCost - a.totalCost);
    });

    const usage = getUsage(organizationId, { from: startOfMonth, to: endOfMonth }).then((data) => {
      const current = (data?.cents ?? 0) / 100;
      const percentageThroughMonth = new Date().getDate() / endOfMonth.getDate();
      return {
        current: current,
        projected: current / percentageThroughMonth,
      };
    });

    return {
      usageOverTime: past30Days,
      usage,
      tasks,
    };
  }
}
