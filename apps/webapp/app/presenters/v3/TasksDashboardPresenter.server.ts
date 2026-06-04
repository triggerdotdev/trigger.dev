import {
  type PrismaClientOrTransaction,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { type ClickHouse } from "@internal/clickhouse";
import { z } from "zod";
import { $replica } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { singleton } from "~/utils/singleton";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";

const DAYS = 7;

export type TaskKind = "AGENT" | "STANDARD" | "SCHEDULED";

export type DailyRunPoint = {
  /** ISO date (YYYY-MM-DD, UTC) */
  day: string;
  count: number;
};

export type TasksDashboardResult = {
  counts: {
    agents: number;
    standard: number;
    scheduled: number;
  };
  series: Promise<{
    agents: DailyRunPoint[];
    standard: DailyRunPoint[];
    scheduled: DailyRunPoint[];
  }>;
};

export class TasksDashboardPresenter {
  constructor(private readonly _replica: PrismaClientOrTransaction) {}

  public async call({
    organizationId,
    environmentId,
    environmentType,
  }: {
    organizationId: string;
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
  }): Promise<TasksDashboardResult> {
    const currentWorker = await findCurrentWorkerFromEnvironment(
      { id: environmentId, type: environmentType },
      this._replica
    );

    if (!currentWorker) {
      return {
        counts: { agents: 0, standard: 0, scheduled: 0 },
        series: Promise.resolve({ agents: [], standard: [], scheduled: [] }),
      };
    }

    const tasks = await this._replica.backgroundWorkerTask.findMany({
      where: { workerId: currentWorker.id },
      select: { triggerSource: true },
    });

    const counts = { agents: 0, standard: 0, scheduled: 0 };
    for (const t of tasks) {
      if (t.triggerSource === "AGENT") counts.agents++;
      else if (t.triggerSource === "SCHEDULED") counts.scheduled++;
      else counts.standard++;
    }

    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
      organizationId,
      "standard"
    );

    return {
      counts,
      series: this.#getDailySeries(clickhouse, environmentId),
    };
  }

  async #getDailySeries(clickhouse: ClickHouse, environmentId: string) {
    const queryFn = clickhouse.reader.query({
      name: "tasksDashboardDailySeries",
      query: `SELECT
          task_kind,
          toDate(created_at) AS day,
          count() AS val
        FROM trigger_dev.task_runs_v2
        WHERE environment_id = {environmentId: String}
          AND created_at >= now() - INTERVAL ${DAYS} DAY
        GROUP BY task_kind, day
        ORDER BY day`,
      params: z.object({ environmentId: z.string() }),
      schema: z.object({
        task_kind: z.string(),
        day: z.string(),
        val: z.coerce.number(),
      }),
    });

    const [error, rows] = await queryFn({ environmentId });
    if (error) {
      console.error("Tasks dashboard daily series query failed:", error);
      return { agents: [], standard: [], scheduled: [] };
    }

    const dayKeys: string[] = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      dayKeys.push(d.toISOString().slice(0, 10));
    }

    const lookup: Record<string, Map<string, number>> = {
      AGENT: new Map(),
      SCHEDULED: new Map(),
      STANDARD: new Map(),
    };
    for (const row of rows) {
      const bucket = lookup[row.task_kind];
      if (bucket) bucket.set(row.day, row.val);
    }

    const buildSeries = (kind: "AGENT" | "SCHEDULED" | "STANDARD"): DailyRunPoint[] =>
      dayKeys.map((day) => ({ day, count: lookup[kind].get(day) ?? 0 }));

    return {
      agents: buildSeries("AGENT"),
      scheduled: buildSeries("SCHEDULED"),
      standard: buildSeries("STANDARD"),
    };
  }
}

export const tasksDashboardPresenter = singleton(
  "tasksDashboardPresenter",
  () => new TasksDashboardPresenter($replica)
);
