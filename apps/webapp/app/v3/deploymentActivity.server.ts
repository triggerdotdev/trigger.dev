import { CalendarDate } from "@internationalized/date";
import { Prisma, WorkerDeploymentStatus } from "@trigger.dev/database";
import { addDays } from "~/components/deployments/deployActivityDays";
import type { PrismaClientOrTransaction } from "~/db.server";
import { isValidTimeZone } from "~/utils/timezones.server";

/** How far back the activity grid reads: 53 week columns. */
const DEPLOYMENT_ACTIVITY_DAYS = 371;

export type DeploymentActivityDay = {
  /** YYYY-MM-DD in the viewer's time zone. */
  day: string;
  /** Every deployment started that day, whatever happened to it. */
  total: number;
  deployed: number;
  /** Failed or timed out. */
  failed: number;
};

export type DeploymentOnDay = {
  shortCode: string;
  version: string;
  status: WorkerDeploymentStatus;
  createdAt: Date;
  deployedBy: string | null;
  commitMessage: string | null;
};

/** The time zone when the runtime knows it, or UTC. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
}

/*
 * Calendar days are worked out here, never by Postgres. The viewer's time zone is whatever name
 * their browser reported, and Postgres doesn't know every name the runtime does: on a Postgres
 * that uses the system's zone data, `AT TIME ZONE 'Asia/Calcutta'` (what Chrome reports for India)
 * is an error. So the queries only ever get instants.
 */

/** The calendar day (YYYY-MM-DD) it is in the time zone. */
function calendarDayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The instant a calendar day starts in the time zone. Where a clock change makes midnight happen
 * twice it's the first one, and where it skips midnight it's the first moment after.
 */
function startOfDayIn(day: string, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new CalendarDate(year, month, date).toDate(timeZone);
}

/**
 * Every status but DEPLOYED (the deploys that didn't go live, or haven't yet), as SQL literals.
 * Written into the query, not bound as a parameter: a bound list arrives as text[] and is cast to
 * the enum, which the planner can't estimate, so it reads every row of the environment instead of
 * using the status index (measured: 68 ms against 1 ms). The values are the enum's own names.
 */
const NOT_DEPLOYED_STATUSES_SQL = Prisma.raw(
  Object.values(WorkerDeploymentStatus)
    .filter((status) => status !== "DEPLOYED")
    .map((status) => `'${status}'`)
    .join(", ")
);

/**
 * An environment's deployments per day for the last 53 weeks, for the activity grid. Two grouped
 * counts, so that it doesn't read a table row for every deployment just to learn its status:
 * - every deployment per day, from `@@index([environmentId, createdAt])` alone (an index-only
 *   scan once the table's pages are vacuumed);
 * - the ones that didn't go live per day, found through `@@index([environmentId, status, id])`,
 *   which reads only those rows. In a healthy environment that's a small share.
 * What went live is the difference. Measured on an environment with 20,000 deploys in the range:
 * about 7 ms and 1,900 pages, against 70 to 110 ms and 18,400 pages as a single count.
 *
 * The days are the viewer's calendar days, cut at instants worked out here (see above).
 */
export async function deploymentActivityByDay(
  prisma: PrismaClientOrTransaction,
  /** The database schema the tables are in (`sqlDatabaseSchema`). */
  schema: Prisma.Sql,
  {
    environmentId,
    timeZone,
    now = new Date(),
  }: { environmentId: string; timeZone: string; now?: Date }
): Promise<{ today: string; days: DeploymentActivityDay[] }> {
  const today = calendarDayIn(timeZone, now);
  // The grid's first week starts at most 370 days back; the last entry is where today ends.
  const days = Array.from({ length: DEPLOYMENT_ACTIVITY_DAYS + 2 }, (_, index) =>
    addDays(today, index - DEPLOYMENT_ACTIVITY_DAYS)
  );
  const starts = days.map((day) => startOfDayIn(day, timeZone));
  const from = starts[0];
  // A deployment's day is where its time falls between the day starts: `width_bucket` returns
  // 1 for the first day. The starts are written the way the column holds time (UTC, no zone), and
  // inside a scalar subquery so the array is built once: as a bare cast it is rebuilt for every
  // row (measured: 620 ms against 6 ms at 20,000 deploys).
  const bucket = Prisma.sql`width_bucket(wd."createdAt", (SELECT ${starts.map((start) => start.toISOString().slice(0, -1))}::timestamp[]))`;

  const [totals, notDeployed] = await Promise.all([
    prisma.$queryRaw<{ bucket: number; total: bigint }[]>`
      SELECT ${bucket} AS bucket, COUNT(*) AS total
      FROM ${schema}."WorkerDeployment" AS wd
      WHERE wd."environmentId" = ${environmentId} AND wd."createdAt" >= ${from}
      GROUP BY 1
      ORDER BY 1`,
    prisma.$queryRaw<{ bucket: number; total: bigint; failed: bigint }[]>`
      SELECT
        ${bucket} AS bucket,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE wd."status" IN ('FAILED', 'TIMED_OUT')) AS failed
      FROM ${schema}."WorkerDeployment" AS wd
      WHERE wd."environmentId" = ${environmentId}
        AND wd."status" IN (${NOT_DEPLOYED_STATUSES_SQL})
        AND wd."createdAt" >= ${from}
      GROUP BY 1`,
  ]);

  const notDeployedByBucket = new Map(notDeployed.map((row) => [row.bucket, row]));
  return {
    today,
    days: totals
      // Bucket 0 is before the first day and the last one is after today (a clock ahead of ours).
      .filter((row) => row.bucket >= 1 && row.bucket < days.length)
      .map((row) => {
        const total = Number(row.total);
        const other = notDeployedByBucket.get(row.bucket);
        return {
          day: days[row.bucket - 1],
          total,
          // The two counts aren't one snapshot: a deploy finishing between them can't go negative.
          deployed: Math.max(0, total - Number(other?.total ?? 0)),
          failed: Number(other?.failed ?? 0),
        };
      }),
  };
}

/**
 * `wd."createdAt"` falls on this calendar day in the time zone: from the instant the day starts
 * there to the instant the next one does. A range on `createdAt`, so it uses the same index.
 */
export function deploymentDaySql(day: string, timeZone: string): Prisma.Sql {
  return Prisma.sql`wd."createdAt" >= ${startOfDayIn(day, timeZone)}
      AND wd."createdAt" < ${startOfDayIn(addDays(day, 1), timeZone)}`;
}

/** The deployments made on one day, newest first, for the grid's hover card. */
export async function deploymentsOnDay(
  prisma: PrismaClientOrTransaction,
  schema: Prisma.Sql,
  {
    environmentId,
    day,
    timeZone,
    limit = 6,
  }: { environmentId: string; day: string; timeZone: string; limit?: number }
): Promise<DeploymentOnDay[]> {
  const rows = await prisma.$queryRaw<
    {
      shortCode: string;
      version: string;
      status: WorkerDeploymentStatus;
      createdAt: Date;
      userName: string | null;
      userDisplayName: string | null;
      commitAuthor: string | null;
      commitMessage: string | null;
    }[]
  >`
    SELECT
      wd."shortCode",
      wd."version",
      wd."status",
      wd."createdAt",
      u."name" AS "userName",
      u."displayName" AS "userDisplayName",
      wd."git"->>'commitAuthorName' AS "commitAuthor",
      wd."git"->>'commitMessage' AS "commitMessage"
    FROM ${schema}."WorkerDeployment" AS wd
    LEFT JOIN ${schema}."User" AS u ON wd."triggeredById" = u."id"
    WHERE wd."environmentId" = ${environmentId}
      AND ${deploymentDaySql(day, timeZone)}
    ORDER BY wd."createdAt" DESC
    LIMIT ${limit}`;

  return rows.map((row) => ({
    shortCode: row.shortCode,
    version: row.version,
    status: row.status,
    createdAt: row.createdAt,
    deployedBy: row.userName ?? row.userDisplayName ?? row.commitAuthor,
    commitMessage: row.commitMessage,
  }));
}
