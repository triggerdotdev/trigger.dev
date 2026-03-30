import {
  type PrismaClientOrTransaction,
  type RuntimeEnvironmentType,
  type TaskTriggerSource,
} from "@trigger.dev/database";
import { ClickHouse } from "@internal/clickhouse";
import { z } from "zod";
import { $replica } from "~/db.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { singleton } from "~/utils/singleton";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";

export type AgentListItem = {
  slug: string;
  filePath: string;
  createdAt: Date;
  triggerSource: TaskTriggerSource;
  config: unknown;
};

export type AgentActiveState = {
  running: number;
  suspended: number;
};

export class AgentListPresenter {
  constructor(
    private readonly clickhouse: ClickHouse,
    private readonly _replica: PrismaClientOrTransaction
  ) {}

  public async call({
    organizationId,
    projectId,
    environmentId,
    environmentType,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
  }) {
    const currentWorker = await findCurrentWorkerFromEnvironment(
      {
        id: environmentId,
        type: environmentType,
      },
      this._replica
    );

    if (!currentWorker) {
      return {
        agents: [],
        activeStates: Promise.resolve({} as Record<string, AgentActiveState>),
        conversationSparklines: Promise.resolve({} as Record<string, number[]>),
        costSparklines: Promise.resolve({} as Record<string, number[]>),
        tokenSparklines: Promise.resolve({} as Record<string, number[]>),
      };
    }

    const agents = await this._replica.backgroundWorkerTask.findMany({
      where: {
        workerId: currentWorker.id,
        triggerSource: "AGENT",
      },
      select: {
        id: true,
        slug: true,
        filePath: true,
        triggerSource: true,
        config: true,
        createdAt: true,
      },
      orderBy: {
        slug: "asc",
      },
    });

    const slugs = agents.map((a) => a.slug);

    if (slugs.length === 0) {
      return {
        agents,
        activeStates: Promise.resolve({} as Record<string, AgentActiveState>),
        conversationSparklines: Promise.resolve({} as Record<string, number[]>),
        costSparklines: Promise.resolve({} as Record<string, number[]>),
        tokenSparklines: Promise.resolve({} as Record<string, number[]>),
      };
    }

    // All queries are deferred for streaming
    const activeStates = this.#getActiveStates(environmentId, slugs);
    const conversationSparklines = this.#getConversationSparklines(environmentId, slugs);
    const costSparklines = this.#getCostSparklines(environmentId, slugs);
    const tokenSparklines = this.#getTokenSparklines(environmentId, slugs);

    return { agents, activeStates, conversationSparklines, costSparklines, tokenSparklines };
  }

  /** Count runs currently executing vs suspended per agent */
  async #getActiveStates(
    environmentId: string,
    slugs: string[]
  ): Promise<Record<string, AgentActiveState>> {
    const queryFn = this.clickhouse.reader.query({
      name: "agentActiveStates",
      query: `SELECT
          task_identifier,
          countIf(status = 'EXECUTING') AS running,
          countIf(status IN ('WAITING_TO_RESUME', 'QUEUED_EXECUTING')) AS suspended
        FROM trigger_dev.task_runs_v2
        WHERE environment_id = {environmentId: String}
          AND task_identifier IN {slugs: Array(String)}
          AND task_kind = 'AGENT'
          AND status IN ('EXECUTING', 'WAITING_TO_RESUME', 'QUEUED_EXECUTING')
        GROUP BY task_identifier`,
      params: z.object({
        environmentId: z.string(),
        slugs: z.array(z.string()),
      }),
      schema: z.object({
        task_identifier: z.string(),
        running: z.coerce.number(),
        suspended: z.coerce.number(),
      }),
    });

    const [error, rows] = await queryFn({ environmentId, slugs });
    if (error) {
      console.error("Agent active states query failed:", error);
      return {};
    }

    const result: Record<string, AgentActiveState> = {};
    for (const row of rows) {
      result[row.task_identifier] = { running: row.running, suspended: row.suspended };
    }
    return result;
  }

  /** 24h hourly sparkline of conversation (run) count per agent */
  async #getConversationSparklines(
    environmentId: string,
    slugs: string[]
  ): Promise<Record<string, number[]>> {
    const queryFn = this.clickhouse.reader.query({
      name: "agentConversationSparklines",
      query: `SELECT
          task_identifier,
          toStartOfHour(created_at) AS bucket,
          count() AS val
        FROM trigger_dev.task_runs_v2
        WHERE environment_id = {environmentId: String}
          AND task_identifier IN {slugs: Array(String)}
          AND task_kind = 'AGENT'
          AND created_at >= now() - INTERVAL 24 HOUR
        GROUP BY task_identifier, bucket
        ORDER BY task_identifier, bucket`,
      params: z.object({
        environmentId: z.string(),
        slugs: z.array(z.string()),
      }),
      schema: z.object({
        task_identifier: z.string(),
        bucket: z.string(),
        val: z.coerce.number(),
      }),
    });

    return this.#buildSparklineMap(await queryFn({ environmentId, slugs }), slugs);
  }

  /** 24h hourly sparkline of LLM cost per agent */
  async #getCostSparklines(
    environmentId: string,
    slugs: string[]
  ): Promise<Record<string, number[]>> {
    const queryFn = this.clickhouse.reader.query({
      name: "agentCostSparklines",
      query: `SELECT
          task_identifier,
          toStartOfHour(start_time) AS bucket,
          sum(total_cost) AS val
        FROM trigger_dev.llm_metrics_v1
        WHERE environment_id = {environmentId: String}
          AND task_identifier IN {slugs: Array(String)}
          AND start_time >= now() - INTERVAL 24 HOUR
        GROUP BY task_identifier, bucket
        ORDER BY task_identifier, bucket`,
      params: z.object({
        environmentId: z.string(),
        slugs: z.array(z.string()),
      }),
      schema: z.object({
        task_identifier: z.string(),
        bucket: z.string(),
        val: z.coerce.number(),
      }),
    });

    return this.#buildSparklineMap(await queryFn({ environmentId, slugs }), slugs);
  }

  /** 24h hourly sparkline of total tokens per agent */
  async #getTokenSparklines(
    environmentId: string,
    slugs: string[]
  ): Promise<Record<string, number[]>> {
    const queryFn = this.clickhouse.reader.query({
      name: "agentTokenSparklines",
      query: `SELECT
          task_identifier,
          toStartOfHour(start_time) AS bucket,
          sum(total_tokens) AS val
        FROM trigger_dev.llm_metrics_v1
        WHERE environment_id = {environmentId: String}
          AND task_identifier IN {slugs: Array(String)}
          AND start_time >= now() - INTERVAL 24 HOUR
        GROUP BY task_identifier, bucket
        ORDER BY task_identifier, bucket`,
      params: z.object({
        environmentId: z.string(),
        slugs: z.array(z.string()),
      }),
      schema: z.object({
        task_identifier: z.string(),
        bucket: z.string(),
        val: z.coerce.number(),
      }),
    });

    return this.#buildSparklineMap(await queryFn({ environmentId, slugs }), slugs);
  }

  /** Convert ClickHouse query result to sparkline map with zero-filled 24 hourly buckets */
  #buildSparklineMap(
    queryResult: [Error, null] | [null, { task_identifier: string; bucket: string; val: number }[]],
    slugs: string[]
  ): Record<string, number[]> {
    const [error, rows] = queryResult;
    if (error) {
      console.error("Agent sparkline query failed:", error);
      return {};
    }
    return this.#buildSparklineFromRows(rows, slugs);
  }

  #buildSparklineFromRows(
    rows: { task_identifier: string; bucket: string; val: number }[],
    slugs: string[]
  ): Record<string, number[]> {
    const now = new Date();
    const startHour = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours() - 23,
        0,
        0,
        0
      )
    );

    const bucketKeys: string[] = [];
    for (let i = 0; i < 24; i++) {
      const h = new Date(startHour.getTime() + i * 3600_000);
      bucketKeys.push(h.toISOString().slice(0, 13).replace("T", " ") + ":00:00");
    }

    const rowMap = new Map<string, number>();
    for (const row of rows) {
      rowMap.set(`${row.task_identifier}|${row.bucket}`, row.val);
    }

    const result: Record<string, number[]> = {};
    for (const slug of slugs) {
      result[slug] = bucketKeys.map((key) => rowMap.get(`${slug}|${key}`) ?? 0);
    }
    return result;
  }
}

export const agentListPresenter = singleton("agentListPresenter", setupAgentListPresenter);

function setupAgentListPresenter() {
  return new AgentListPresenter(clickhouseClient, $replica);
}
