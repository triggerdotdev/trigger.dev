import { PrismaClientOrTransaction, sqlDatabaseSchema } from "~/db.server";
import { env } from "~/env.server";
import { getUsage, getUsageSeries } from "~/services/platform.v3.server";
import { createTimeSeriesData } from "~/utils/graphs";
import { BasePresenter } from "./basePresenter.server";
import { DataPoint, linear } from "regression";
import { clickhouseClient } from "~/services/clickhouseInstance.server";

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
    if (isNaN(startDate.getTime())) {
      throw new Error("Invalid start date");
    }

    //month period
    const startOfMonth = new Date(startDate);
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);

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
    const usage = getUsageSeries(organizationId, {
      from: startOfMonth,
      to: endOfMonth,
      window: "DAY",
    }).then((data) => {
      //we want to sum it to get the total usage
      const current = (data?.data.reduce((acc, period) => acc + period.value, 0) ?? 0) / 100;

      // Get the start day (the day the customer started using the product) or the first day of the month
      const startDay = new Date(data?.data.at(0)?.windowStart ?? startOfMonth).getDate();

      // We want to project so we convert the data into an array of tuples [dayNumber, value]
      const projectionData =
        data?.data.map((period, index) => {
          // Each value should be the sum of the previous values + the current value
          // Adjust the day number to start from 1 when the customer started using the product
          return [
            new Date(period.windowStart).getDate() - startDay + 1,
            data.data.slice(0, index + 1).reduce((acc, period) => acc + period.value, 0) / 100,
          ] as DataPoint;
        }) ?? ([] as DataPoint[]);

      const result = linear(projectionData);
      const [a, b] = result.equation;

      // Adjust the total days in the month based on when the customer started
      const totalDaysInMonth = endOfMonth.getDate() - startDay + 1;
      const projected = a * totalDaysInMonth + b;
      const overall = {
        current,
        projected,
      };

      //and create daily data for the graph
      const timeSeries = createTimeSeriesData({
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

      return {
        overall,
        timeSeries,
      };
    });

    //usage by task
    const tasks = await getTaskUsageByOrganization(
      organizationId,
      startOfMonth,
      endOfMonth,
      this._replica
    );

    return {
      usage,
      tasks,
    };
  }
}

async function getTaskUsageByOrganization(
  organizationId: string,
  startOfMonth: Date,
  endOfMonth: Date,
  replica: PrismaClientOrTransaction
) {
  const [queryError, tasks] = await clickhouseClient.taskRuns.getTaskUsageByOrganization({
    startTime: startOfMonth.getTime(),
    endTime: endOfMonth.getTime(),
    organizationId,
  });

  if (queryError) {
    throw queryError;
  }

  return tasks
    .map((task) => ({
      taskIdentifier: task.task_identifier,
      runCount: Number(task.run_count),
      averageDuration: Number(task.average_duration),
      averageCost: Number(task.average_cost) + env.CENTS_PER_RUN / 100,
      totalDuration: Number(task.total_duration),
      totalCost: Number(task.total_cost) + Number(task.total_base_cost),
    }))
    .sort((a, b) => b.totalCost - a.totalCost);
}
