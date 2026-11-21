import { type ClickHouse } from "@internal/clickhouse";
import { z } from "zod";
import {
  chooseBucketSeconds,
  zeroFillGroupedSeries,
  zeroFillScalarSeries,
} from "./activitySeries.server";

type AgentActivityPoint = {
  bucket: number; // epoch ms
} & Record<string, number>;

export type AgentModelUsage = { model: string; calls: number; cost: number };

export type AgentActivity = {
  data: AgentActivityPoint[];
  statuses: string[];
};

// Stable legend order for the sessions activity chart. Derived statuses:
//   ACTIVE  = closed_at IS NULL AND (expires_at IS NULL OR expires_at > now)
//   CLOSED  = closed_at IS NOT NULL
//   EXPIRED = closed_at IS NULL AND expires_at <= now
const SESSION_STATUSES = ["ACTIVE", "CLOSED", "EXPIRED"] as const;
type SessionStatusLabel = (typeof SESSION_STATUSES)[number];

export class AgentDetailPresenter {
  constructor(private readonly clickhouse: ClickHouse) {}

  async getSessionActivity({
    organizationId,
    projectId,
    environmentId,
    agentSlug,
    from,
    to,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    agentSlug: string;
    from: Date;
    to: Date;
  }): Promise<AgentActivity> {
    const rangeMs = Math.max(1, to.getTime() - from.getTime());
    const bucketSeconds = chooseBucketSeconds(rangeMs);

    // FINAL collapses ReplacingMergeTree versions so we see each session's
    // latest state — important since closed_at / expires_at are mutated
    // post-insert. Org/project filters engage the sort-key prefix.
    const queryFn = this.clickhouse.reader.query({
      name: "agentSessionStatusActivity",
      query: `SELECT
          toUnixTimestamp(toStartOfInterval(created_at, INTERVAL {bucketSeconds: UInt32} SECOND)) AS bucket,
          multiIf(
            closed_at IS NOT NULL, 'CLOSED',
            expires_at IS NOT NULL AND expires_at <= now64(3), 'EXPIRED',
            'ACTIVE'
          ) AS status,
          count() AS val
        FROM trigger_dev.sessions_v1 FINAL
        WHERE organization_id = {organizationId: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND task_identifier = {agentSlug: String}
          AND _is_deleted = 0
          AND created_at >= {fromTime: DateTime64(3, 'UTC')}
          AND created_at < {toTime: DateTime64(3, 'UTC')}
        GROUP BY bucket, status
        ORDER BY bucket`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        agentSlug: z.string(),
        bucketSeconds: z.number(),
        fromTime: z.string(),
        toTime: z.string(),
      }),
      schema: z.object({
        bucket: z.coerce.number(),
        status: z.string(),
        val: z.coerce.number(),
      }),
    });

    const [error, rows] = await queryFn({
      organizationId,
      projectId,
      environmentId,
      agentSlug,
      bucketSeconds,
      fromTime: from.toISOString().slice(0, -1),
      toTime: to.toISOString().slice(0, -1),
    });

    if (error) {
      console.error("Agent session activity query failed:", error);
      return { data: [], statuses: [] };
    }

    const orderedStatuses: SessionStatusLabel[] = [...SESSION_STATUSES];
    const points = zeroFillGroupedSeries({
      rows,
      from,
      to,
      bucketSeconds,
      orderedKeys: orderedStatuses,
    });

    return { data: points, statuses: orderedStatuses };
  }

  async getLlmCostActivity(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    agentSlug: string;
    from: Date;
    to: Date;
  }): Promise<AgentActivity> {
    return this.#llmActivity({ ...input, metric: "cost" });
  }

  async getLlmTokenActivity(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    agentSlug: string;
    from: Date;
    to: Date;
  }): Promise<AgentActivity> {
    return this.#llmActivity({ ...input, metric: "tokens" });
  }

  /** The models the agent called in the period, most calls first. */
  async getModelUsage({
    organizationId,
    projectId,
    environmentId,
    agentSlug,
    from,
    to,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    agentSlug: string;
    from: Date;
    to: Date;
  }): Promise<AgentModelUsage[]> {
    // Same pruning as #llmActivity: inserted_at >= start_time always holds.
    const queryFn = this.clickhouse.reader.query({
      name: "agentLlmModelUsage",
      query: `SELECT
          if(response_model != '', response_model, request_model) AS model,
          count() AS calls,
          toFloat64(sum(total_cost)) AS cost
        FROM trigger_dev.llm_metrics_v1
        WHERE organization_id = {organizationId: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND task_identifier = {agentSlug: String}
          AND inserted_at >= {fromTime: DateTime64(3, 'UTC')}
          AND start_time >= {fromTime: DateTime64(3, 'UTC')}
          AND start_time < {toTime: DateTime64(3, 'UTC')}
        GROUP BY model
        ORDER BY calls DESC
        LIMIT 3`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        agentSlug: z.string(),
        fromTime: z.string(),
        toTime: z.string(),
      }),
      schema: z.object({
        model: z.string(),
        calls: z.coerce.number(),
        cost: z.coerce.number(),
      }),
    });

    const [error, rows] = await queryFn({
      organizationId,
      projectId,
      environmentId,
      agentSlug,
      fromTime: from.toISOString().slice(0, -1),
      toTime: to.toISOString().slice(0, -1),
    });

    if (error) {
      console.error("Agent LLM model usage query failed:", error);
      return [];
    }
    return rows.filter((row) => row.model !== "");
  }

  async #llmActivity({
    organizationId,
    projectId,
    environmentId,
    agentSlug,
    from,
    to,
    metric,
  }: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    agentSlug: string;
    from: Date;
    to: Date;
    metric: "cost" | "tokens";
  }): Promise<AgentActivity> {
    const rangeMs = Math.max(1, to.getTime() - from.getTime());
    const bucketSeconds = chooseBucketSeconds(rangeMs);

    const seriesKey = metric === "cost" ? "cost" : "tokens";
    // total_cost is Decimal64(12); cast to Float64 so the JSON wire format is
    // a plain number rather than a string.
    const sumExpr = metric === "cost" ? "toFloat64(sum(total_cost))" : "sum(total_tokens)";

    // llm_metrics_v1 is partitioned by toDate(inserted_at); filtering on
    // inserted_at lets ClickHouse prune partitions (start_time alone touches
    // every monthly partition in the 365d TTL). The writer sets
    // inserted_at = now64(3) at insert, so inserted_at >= start_time is an
    // invariant and using `fromTime` here is safe.
    const queryFn = this.clickhouse.reader.query({
      name: metric === "cost" ? "agentLlmCostActivity" : "agentLlmTokenActivity",
      query: `SELECT
          toUnixTimestamp(toStartOfInterval(start_time, INTERVAL {bucketSeconds: UInt32} SECOND)) AS bucket,
          ${sumExpr} AS val
        FROM trigger_dev.llm_metrics_v1
        WHERE organization_id = {organizationId: String}
          AND project_id = {projectId: String}
          AND environment_id = {environmentId: String}
          AND task_identifier = {agentSlug: String}
          AND inserted_at >= {fromTime: DateTime64(3, 'UTC')}
          AND start_time >= {fromTime: DateTime64(3, 'UTC')}
          AND start_time < {toTime: DateTime64(3, 'UTC')}
        GROUP BY bucket
        ORDER BY bucket`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
        agentSlug: z.string(),
        bucketSeconds: z.number(),
        fromTime: z.string(),
        toTime: z.string(),
      }),
      schema: z.object({
        bucket: z.coerce.number(),
        val: z.coerce.number(),
      }),
    });

    const [error, rows] = await queryFn({
      organizationId,
      projectId,
      environmentId,
      agentSlug,
      bucketSeconds,
      fromTime: from.toISOString().slice(0, -1),
      toTime: to.toISOString().slice(0, -1),
    });

    if (error) {
      console.error(`Agent LLM ${metric} activity query failed:`, error);
      return { data: [], statuses: [] };
    }

    const points = zeroFillScalarSeries({ rows, from, to, bucketSeconds, seriesKey });

    return { data: points, statuses: [seriesKey] };
  }
}
