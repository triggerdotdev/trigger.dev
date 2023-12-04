import { formatDateTime } from "~/components/primitives/DateTime";
import { PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";

export class OrgUsagePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, slug }: { userId: string; slug: string }) {
    const organization = await this.#prismaClient.organization.findFirst({
      where: {
        slug,
        members: {
          some: {
            userId,
          },
        },
      },
    });

    if (!organization) {
      return;
    }

    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const startOfLastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1); // this works for January as well

    // Get count of runs since the start of the current month
    const runsCount = await this.#prismaClient.jobRun.count({
      where: {
        organizationId: organization.id,
        createdAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        },
        internal: false,
      },
    });

    // Get the count of runs for last month
    const runsCountLastMonth = await this.#prismaClient.jobRun.count({
      where: {
        organizationId: organization.id,
        createdAt: {
          gte: startOfLastMonth,
          lt: startOfMonth,
        },
        internal: false,
      },
    });

    // Get the count of the runs for the last 6 months, by month. So for example we want the data shape to be:
    // [
    //   { month: "2021-01", count: 10 },
    //   { month: "2021-02", count: 20 },
    //   { month: "2021-03", count: 30 },
    //   { month: "2021-04", count: 40 },
    //   { month: "2021-05", count: 50 },
    //   { month: "2021-06", count: 60 },
    // ]
    // This will be used to generate the chart on the usage page
    // Use prisma queryRaw for this since prisma doesn't support grouping by month
    const monthlyRunsDataRaw = await this.#prismaClient.$queryRaw<
      {
        month: string;
        count: number;
      }[]
    >`SELECT TO_CHAR("createdAt", 'YYYY-MM') as month, COUNT(*) as count FROM "JobRun" WHERE "organizationId" = ${organization.id} AND "createdAt" >= NOW() - INTERVAL '6 months' AND "internal" = FALSE GROUP BY month ORDER BY month ASC`;

    const monthlyRunsData = monthlyRunsDataRaw.map((obj) => ({
      name: obj.month,
      total: Number(obj.count), // Convert BigInt to Number
    }));

    const monthlyRunsDataDisplay = fillInMissingRunMonthlyData(monthlyRunsData, 6);

    const totalJobs = await this.#prismaClient.job.count({
      where: {
        organizationId: organization.id,
        internal: false,
      },
    });

    const totalJobsLastMonth = await this.#prismaClient.job.count({
      where: {
        organizationId: organization.id,
        createdAt: {
          lt: startOfMonth,
        },
        deletedAt: null,
        internal: false,
      },
    });

    const totalIntegrations = await this.#prismaClient.integration.count({
      where: {
        organizationId: organization.id,
      },
    });

    const totalIntegrationsLastMonth = await this.#prismaClient.integration.count({
      where: {
        organizationId: organization.id,
        createdAt: {
          lt: startOfMonth,
        },
      },
    });

    const totalMembers = await this.#prismaClient.orgMember.count({
      where: {
        organizationId: organization.id,
      },
    });

    // Max concurrency each day over past 30 days
    const concurrencyChartRawData = await this.#prismaClient.$queryRaw<
      { day: Date; max_concurrent_runs: BigInt }[]
    >`
      WITH time_boundaries AS (
        SELECT generate_series(
            NOW() - interval '30 days', 
            NOW(), 
            interval '1 day'
        ) AS day_start
      ),
      events AS (
          SELECT
              day_start,
              event_time,
              event_type,
              SUM(event_type) OVER (ORDER BY event_time) AS running_total
          FROM
              time_boundaries
          JOIN
              triggerdotdev_events.run_executions
          ON
              event_time >= day_start AND event_time < day_start + interval '1 day'
          WHERE triggerdotdev_events.run_executions.organization_id = ${organization.id}
      ),
      max_concurrent_per_day AS (
          SELECT
              date_trunc('day', event_time) AS day,
              MAX(running_total) AS max_concurrent_runs
          FROM
              events
          GROUP BY day
      )
      SELECT
          day,
          max_concurrent_runs
      FROM
          max_concurrent_per_day
      ORDER BY
          day;`;

    const ThirtyDaysAgo = new Date();
    ThirtyDaysAgo.setDate(ThirtyDaysAgo.getDate() - 30);
    ThirtyDaysAgo.setHours(0, 0, 0, 0);

    const concurrencyChartRawDataFilledIn = fillInMissingConcurrencyDays(
      ThirtyDaysAgo,
      30,
      concurrencyChartRawData
    );

    return {
      id: organization.id,
      runsCount,
      runsCountLastMonth,
      monthlyRunsData: monthlyRunsDataDisplay,
      concurrencyData: concurrencyChartRawDataFilledIn,
      totalJobs,
      totalJobsLastMonth,
      totalIntegrations,
      totalIntegrationsLastMonth,
      totalMembers,
    };
  }
}

// This will fill in missing chart data with zeros
// So for example, if data is [{ name: "2021-01", total: 10 }, { name: "2021-03", total: 30 }] and the totalNumberOfMonths is 6
// And the current month is "2021-04", then this function will return:
// [{ name: "2020-11", total: 0 }, { name: "2020-12", total: 0 }, { name: "2021-01", total: 10 }, { name: "2021-02", total: 0 }, { name: "2021-03", total: 30 }, { name: "2021-04", total: 0 }]
function fillInMissingRunMonthlyData(
  data: Array<{ name: string; total: number }>,
  totalNumberOfMonths: number
): Array<{ name: string; total: number }> {
  const currentMonth = new Date().toISOString().slice(0, 7);

  const startMonth = new Date(
    new Date(currentMonth).getFullYear(),
    new Date(currentMonth).getMonth() - (totalNumberOfMonths - 2),
    1
  )
    .toISOString()
    .slice(0, 7);

  const months = getMonthsBetween(startMonth, currentMonth);

  let completeData = months.map((month) => {
    let foundData = data.find((d) => d.name === month);
    return foundData ? { ...foundData } : { name: month, total: 0 };
  });

  return completeData;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

function fillInMissingConcurrencyDays(
  startDate: Date,
  days: number,
  data: Array<{ day: Date; max_concurrent_runs: BigInt }>
) {
  console.log("inputData", data);
  const outputData: Array<{ name: string; maxConcurrentRuns: number }> = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);
    const foundData = data.find((d) => d.day.toISOString() === date.toISOString());
    if (!foundData) {
      outputData.push({
        name: dateFormatter.format(date),
        maxConcurrentRuns: 0,
      });
    } else {
      outputData.push({
        name: dateFormatter.format(date),
        maxConcurrentRuns: Number(foundData.max_concurrent_runs),
      });
    }
  }

  return outputData;
}

// Start month will be like 2023-03 and endMonth will be like 2023-10
// The result should be an array of months between these two months, including the start and end month
// So for example, if startMonth is 2023-03 and endMonth is 2023-10, the result should be:
// ["2023-03", "2023-04", "2023-05", "2023-06", "2023-07", "2023-08", "2023-09", "2023-10"]
function getMonthsBetween(startMonth: string, endMonth: string): string[] {
  // Initialize result array
  const result: string[] = [];

  // Parse the year and month from startMonth and endMonth
  let [startYear, startMonthNum] = startMonth.split("-").map(Number);
  let [endYear, endMonthNum] = endMonth.split("-").map(Number);

  // Loop through each month between startMonth and endMonth
  for (let year = startYear; year <= endYear; year++) {
    let monthStart = year === startYear ? startMonthNum : 1;
    let monthEnd = year === endYear ? endMonthNum : 12;

    for (let month = monthStart; month <= monthEnd; month++) {
      // Format the month into a string and add it to the result array
      result.push(`${year}-${String(month).padStart(2, "0")}`);
    }
  }

  return result;
}

function getLastSecondOfMonth(endMonth: string) {
  const [year, month] = endMonth.split("-").map(Number);
  const nextMonthFirstDay = new Date(year, month, 1);
  nextMonthFirstDay.setDate(0);
  nextMonthFirstDay.setHours(23, 59, 59);
  return nextMonthFirstDay;
}
