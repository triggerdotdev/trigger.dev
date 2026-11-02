import { ClickHouse } from "@internal/clickhouse";
import { clickhouseTest } from "@internal/testcontainers";
import { getCapability } from "@internal/alert-contracts";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ ch: undefined as unknown }));

vi.mock("~/db.server", () => {
  const client = {
    project: { findMany: async () => [] },
    runtimeEnvironment: { findMany: async () => [] },
    customerQuery: { findFirst: async () => null, create: async () => ({ id: "cq_1" }) },
  };
  return { prisma: client, $replica: client };
});
vi.mock("~/env.server", () => ({
  env: {
    QUERY_CLICKHOUSE_MAX_EXECUTION_TIME: 30,
    QUERY_CLICKHOUSE_MAX_MEMORY_USAGE: 1_000_000_000,
    QUERY_CLICKHOUSE_MAX_AST_ELEMENTS: 50000,
    QUERY_CLICKHOUSE_MAX_EXPANDED_AST_ELEMENTS: 500000,
    QUERY_CLICKHOUSE_MAX_BYTES_BEFORE_EXTERNAL_GROUP_BY: 1_000_000_000,
    QUERY_CLICKHOUSE_MAX_RETURNED_ROWS: 1000,
    ALERT_SEEN_RETENTION_SEC: 86_400,
  },
}));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => holder.ch },
}));
vi.mock("~/services/platform.v3.server", () => ({ getLimit: async () => 30 }));
vi.mock("~/services/queryConcurrencyLimiter.server", () => ({
  queryConcurrencyLimiter: {
    acquire: async () => ({ success: true }),
    release: async () => {},
  },
  DEFAULT_ORG_CONCURRENCY_LIMIT: 10,
  GLOBAL_CONCURRENCY_LIMIT: 100,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import type { Alert } from "~/v3/services/alerts/storage/alertStore.server";
import {
  createProductionEvaluateBinding,
  createQueryRowRunner,
} from "~/v3/services/alerts/engine/productionEvaluateBinding.server";

const TENANT = { org: "org_hl", project: "project_hl", env: "env_hl" };
const NOW = Date.now();

function ts(ms: number) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

type Metric = { name: string; value: number; subject?: string; scope?: string };

async function seedMetrics(ch: ClickHouse, metrics: Metric[]) {
  const [error] = await ch.writer.insertUnsafe<Record<string, unknown>>({
    name: "seed-limit-metrics",
    table: "trigger_dev.metrics_v1",
    settings: { async_insert: 0, enable_json_type: 1 },
  })(
    metrics.map((m) => ({
      organization_id: TENANT.org,
      project_id: TENANT.project,
      environment_id: TENANT.env,
      metric_name: m.name,
      metric_type: "gauge",
      metric_subject: m.subject ?? "",
      bucket_start: ts(NOW - 60_000),
      value: m.value,
      attributes: m.scope ? { scope: m.scope } : {},
    }))
  );
  expect(error).toBeNull();
}

async function seedEnvGauge(ch: ClickHouse, running: number, limit: number) {
  const [error] = await ch.writer.insertUnsafe<Record<string, unknown>>({
    name: "seed-env-gauge",
    table: "trigger_dev.queue_metrics_raw_v1",
    settings: { async_insert: 0 },
  })([
    {
      organization_id: TENANT.org,
      project_id: TENANT.project,
      environment_id: TENANT.env,
      queue_name: "q",
      event_time: ts(NOW - 60_000),
      op: "gauge",
      env_running: running,
      env_limit: limit,
    },
  ]);
  expect(error).toBeNull();
}

function alertFor(capabilityKey: string, condition: Record<string, unknown> = {}): Alert {
  return {
    id: "alert_hl",
    organizationId: TENANT.org,
    projectId: TENANT.project,
    environmentId: TENANT.env,
    capabilityKey,
    params: { environmentId: TENANT.env, scope: { type: "all" } },
    condition: { kind: "state", stateKey: capabilityKey, ...condition },
    evaluatorState: null,
    createdAt: new Date(NOW - 3_600_000),
  } as unknown as Alert;
}

async function evaluate(capabilityKey: string, condition: Record<string, unknown> = {}) {
  const binding = createProductionEvaluateBinding({
    queryRowRunner: createQueryRowRunner(10),
    now: () => new Date(NOW),
  });
  const { result } = await binding(
    alertFor(capabilityKey, condition),
    getCapability(capabilityKey)!
  );
  if (result.kind !== "stateful") throw new Error("expected stateful result");
  return result;
}

// ClickHouse's query cache keys on the SQL text, which embeds these ids and the fixed window:
// a shared tenant would serve one test's empty env_metrics result to the next.
function connect(url: string, name: string) {
  Object.assign(TENANT, { org: `org_${name}`, project: `project_${name}`, env: `env_${name}` });
  const ch = new ClickHouse({ url, name });
  holder.ch = ch;
  return ch;
}

describe("Limits composite on ClickHouse metrics", () => {
  clickhouseTest(
    "limits.all without components evaluates every limit",
    async ({ clickhouseContainer }) => {
      const ch = connect(clickhouseContainer.getConnectionUrl(), "hl-default");
      await seedMetrics(ch, [
        { name: "api.rate_limit.denied", value: 3 },
        { name: "api.rate_limit.limit.burst", value: 100 },
        { name: "api.rate_limit.remaining_min", value: 50 },
      ]);
      await seedEnvGauge(ch, 1, 10);
      const everything = await evaluate("limits.all");
      expect(Object.keys(everything.facts.components as object)).toHaveLength(7);
      expect(everything.outcome).toBe("met");
    }
  );
  clickhouseTest(
    "combines selected components by mode and ignores components without data",
    async ({ clickhouseContainer }) => {
      const ch = connect(clickhouseContainer.getConnectionUrl(), "hl-combine");
      await seedMetrics(ch, [
        { name: "api.rate_limit.denied", value: 3 },
        { name: "api.rate_limit.limit.burst", value: 100 },
        { name: "api.rate_limit.remaining_min", value: 50 },
        { name: "queue.size.queued", value: 10 },
        { name: "queue.size.limit", value: 100 },
      ]);

      const any = await evaluate("limits.all", { components: ["limits.api", "limits.queue"] });
      expect(any.outcome).toBe("met");
      const all = await evaluate("limits.all", {
        components: ["limits.api", "limits.queue"],
        compositeMode: "all",
      });
      expect(all.outcome).toBe("not_met");

      const ignored = await evaluate("limits.all", {
        components: ["limits.api", "limits.webhooks.processing"],
        compositeMode: "all",
      });
      expect(ignored.outcome).toBe("met");
      expect(ignored.facts.unavailableComponents).toEqual(["limits.webhooks.processing"]);
      const components = ignored.facts.components as Record<string, Record<string, unknown>>;
      expect(components["limits.webhooks.processing"]!.outcome).toBe("unavailable");
      expect(components["limits.api"]!.signals).toEqual({
        approaching: { value: 50, threshold: 80, met: false },
        limited: { count: 3, met: true },
      });

      const none = await evaluate("limits.all", {
        components: ["limits.webhooks.processing", "limits.webhooks.waiters"],
      });
      expect(none.outcome).toBe("unavailable");
      expect(none.facts.unavailableComponents).toEqual([
        "limits.webhooks.processing",
        "limits.webhooks.waiters",
      ]);
    }
  );

  clickhouseTest(
    "evaluates only the selected signals and maps missing rows to unavailable",
    async ({ clickhouseContainer }) => {
      const ch = connect(clickhouseContainer.getConnectionUrl(), "hl-signals");
      await seedMetrics(ch, [
        { name: "api.rate_limit.allowed", value: 40 },
        { name: "api.rate_limit.denied", value: 0 },
        { name: "api.rate_limit.limit.burst", value: 100 },
        { name: "api.rate_limit.remaining_min", value: 5 },
      ]);

      const both = await evaluate("limits.api");
      expect(both.outcome).toBe("met");
      expect((both.facts.signals as Record<string, unknown>).approaching).toEqual({
        value: 95,
        threshold: 80,
        met: true,
      });

      const limitedOnly = await evaluate("limits.api", { signals: ["limited"] });
      expect(limitedOnly.outcome).toBe("not_met");
      expect(limitedOnly.facts.signals).toEqual({ limited: { count: 0, met: false } });

      const empty = await evaluate("limits.queue");
      expect(empty.outcome).toBe("unavailable");
      expect(empty.facts.unavailableReason).toBe("no_data");

      await seedMetrics(ch, [{ name: "webhook.ingress.limit.tokens", value: 10, scope: "env" }]);
      const limitOnly = await evaluate("limits.webhooks.env_rate", { signals: ["approaching"] });
      expect(limitOnly.outcome).toBe("unavailable");
      expect(limitOnly.facts.signals).toEqual({
        approaching: { value: null, threshold: 80, met: false },
      });
    }
  );

  clickhouseTest(
    "endpoint rate is met when any endpoint trips and environment concurrency reads env_metrics",
    async ({ clickhouseContainer }) => {
      const ch = connect(clickhouseContainer.getConnectionUrl(), "hl-groups");
      await seedMetrics(ch, [
        { name: "webhook.ingress.limit.tokens", value: 100, subject: "ep_ok", scope: "endpoint" },
        { name: "webhook.ingress.remaining_min", value: 90, subject: "ep_ok", scope: "endpoint" },
        { name: "webhook.ingress.denied", value: 0, subject: "ep_ok", scope: "endpoint" },
        { name: "webhook.ingress.limit.tokens", value: 100, subject: "ep_hot", scope: "endpoint" },
        { name: "webhook.ingress.remaining_min", value: 80, subject: "ep_hot", scope: "endpoint" },
        { name: "webhook.ingress.denied", value: 4, subject: "ep_hot", scope: "endpoint" },
      ]);
      await seedEnvGauge(ch, 9, 10);

      const endpoint = await evaluate("limits.webhooks.endpoint_rate");
      expect(endpoint.outcome).toBe("met");
      expect(endpoint.facts.offendingGroups).toEqual(["ep_hot"]);
      expect(endpoint.facts.signals).toEqual({
        approaching: { value: 20, threshold: 80, met: false },
        limited: { count: 4, met: true },
      });

      const concurrency = await evaluate("limits.concurrency");
      expect(concurrency.outcome).toBe("met");
      expect(concurrency.facts.signals).toEqual({
        approaching: { value: 90, threshold: 80, met: true },
        limited: { value: 9, met: false },
      });
    }
  );
});
