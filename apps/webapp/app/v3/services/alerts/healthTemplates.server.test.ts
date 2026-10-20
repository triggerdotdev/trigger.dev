import { ClickHouse, executeTSQL } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { z } from "zod";
import { querySchemas } from "~/v3/querySchemas";
import {
  evaluateQueryCapability,
  type QueryEvaluatorInput,
  type QueryRowRunner,
} from "./evaluators/queryEvaluator.server";

vi.setConfig({ testTimeout: 60_000 });

const SYNC = { params: { clickhouse_settings: { async_insert: 0 as const } } };
const ORG = "org_health_tpl";
const PROJECT = "project_health_tpl";
const ENV = "env_health_tpl";

function clickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function scope() {
  return { organization_id: ORG, project_id: PROJECT, environment_id: ENV, queue_name: "q1" };
}

function makeRunner(clickhouseContainer: { getConnectionUrl(): string }): QueryRowRunner {
  const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "health-tpl" });
  return async (query, context, range) => {
    const matched = querySchemas.find((s) =>
      new RegExp(`\\bFROM\\s+${s.name}\\b`, "i").test(query)
    );
    const timeColumn = matched?.timeConstraint ?? "triggered_at";
    const from = new Date(range.from);
    const to = new Date(range.to);
    const [error, result] = await executeTSQL(ch.reader, {
      name: "health-tpl",
      query,
      schema: z.record(z.string(), z.any()),
      tableSchema: querySchemas,
      transformValues: true,
      enforcedWhereClause: {
        organization_id: { op: "eq", value: context.organizationId },
        project_id: { op: "eq", value: context.projectId },
        environment_id: { op: "eq", value: context.environmentId },
        [timeColumn]: { op: "between", low: from, high: to },
      },
      timeRange: { from, to },
    });
    if (error) throw error;
    return result.rows;
  };
}

function input(overrides: Partial<QueryEvaluatorInput>): QueryEvaluatorInput {
  return {
    capabilityKey: "health.flow",
    organizationId: ORG,
    projectId: PROJECT,
    params: { environmentId: ENV, scope: { type: "all" } },
    condition: { kind: "state", stateKey: "degraded" },
    now: new Date(),
    ...overrides,
  };
}

describe("health templates", () => {
  clickhouseTest(
    "health.flow: a steady backlog below backlogCount across buckets stays healthy",
    async ({ clickhouseContainer }) => {
      const ch = new ClickHouse({ url: clickhouseContainer.getConnectionUrl(), name: "seed" });
      const now = new Date(Math.floor(Date.now() / 10_000) * 10_000);
      const at = (ago: number) => clickhouseDateTime(new Date(now.getTime() - ago));
      const gauge = (ago: number) => ({
        ...scope(),
        event_time: at(ago),
        op: "gauge" as const,
        running: 1,
        queued: 600,
        queue_limit: 10,
      });
      const started = (ago: number, cumulative: number) => ({
        ...scope(),
        event_time: at(ago),
        order_key: (now.getTime() - ago) * 1_000_000,
        op: "started" as const,
        cumulative,
      });

      await ch.queueMetrics.insertRaw(
        [
          gauge(5_000),
          gauge(65_000),
          gauge(125_000),
          started(125_000, 0),
          started(65_000, 5),
          started(5_000, 10),
        ],
        SYNC
      );

      const result = await evaluateQueryCapability(
        input({
          condition: { kind: "state", stateKey: "degraded", params: { backlogCount: 1000 } },
          now,
        }),
        makeRunner(clickhouseContainer)
      );
      expect(result.outcome).toBe("not_met");
    }
  );

  clickhouseTest(
    "health.liveness: silence longer than the evaluation window stays degraded",
    async ({ clickhouseContainer }) => {
      const result = await evaluateQueryCapability(
        input({
          capabilityKey: "health.liveness",
          condition: { kind: "state", stateKey: "degraded", params: { silenceSec: 300 } },
        }),
        makeRunner(clickhouseContainer)
      );
      expect(result.outcome).toBe("met");
    }
  );
});
