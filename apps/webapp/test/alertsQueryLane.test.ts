import { ClickHouse } from "@internal/clickhouse";
import { containerTestWithClickhouse } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { RedisConcurrencyLimiter } from "~/services/redisConcurrencyLimiter.server";
import type * as DbServer from "~/db.server";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({
  ch: undefined as unknown,
  prisma: undefined as unknown as Record<string | symbol, unknown>,
  limiter: undefined as unknown,
}));

vi.mock("~/db.server", async (importOriginal) => {
  const actual = await importOriginal<typeof DbServer>();
  const prisma = new Proxy({}, { get: (_target, prop) => holder.prisma[prop] });
  return { ...actual, prisma, $replica: prisma };
});
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => holder.ch },
}));
vi.mock("~/services/queryConcurrencyLimiter.server", () => ({
  queryConcurrencyLimiter: {
    acquire: (options: unknown) => (holder.limiter as any).acquire(options),
    release: (options: unknown) => (holder.limiter as any).release(options),
  },
  DEFAULT_ORG_CONCURRENCY_LIMIT: 3,
  GLOBAL_CONCURRENCY_LIMIT: 100,
}));

import type { AlertParams, Condition } from "@internal/alert-contracts";
import { isQueryConcurrencyRejection } from "~/services/queryService.server";
import { querySchemas } from "~/v3/querySchemas";
import { createQueryRowRunner } from "~/v3/services/alerts/engine/productionEvaluateBinding.server";
import {
  analyzeQueryForAlert,
  toQuerySignal,
} from "~/v3/services/alerts/queryAlerts/analyzeQueryForAlert.server";
import { getQueryAlertSeries } from "~/v3/services/alerts/queryAlerts/queryAlertSeries.server";
import { resolveAlertCapability } from "~/v3/services/alerts/queryAlerts/resolveAlertCapability.server";

const TENANT = { org: "org_lane", project: "proj_lane", env: "env_lane" };
const MIN = 60_000;
const HOUR = 60 * MIN;
const QUERY = "SELECT count() AS failures FROM runs";
const CONTEXT = {
  organizationId: TENANT.org,
  projectId: TENANT.project,
  environmentId: TENANT.env,
};

function toLimiterRedis(o: any) {
  return {
    host: o.host,
    port: o.port,
    username: o.username,
    password: o.password,
    tlsDisabled: true,
  } as never;
}

function setup(clickhouseUrl: string, prisma: PrismaClient, redis: object, suffix: string) {
  const limiter = new RedisConcurrencyLimiter({
    keyPrefix: `alerts-lane:${suffix}`,
    redis: toLimiterRedis(redis),
  });
  holder.limiter = limiter;
  holder.prisma = prisma as unknown as Record<string | symbol, unknown>;
  holder.ch = new ClickHouse({ url: clickhouseUrl, name: "alerts-lane" });
  return limiter;
}

async function hold(limiter: RedisConcurrencyLimiter, key: string, count: number) {
  for (let i = 0; i < count; i++) {
    const held = await limiter.acquire({
      key,
      requestId: `held_${i}`,
      keyLimit: 100,
      globalLimit: 100,
    });
    expect(held).toEqual({ success: true });
  }
}

async function runOn(lane: "user" | "alerts") {
  const range = { from: new Date(Date.now() - HOUR).toISOString(), to: new Date().toISOString() };
  return createQueryRowRunner(1, { lane })(QUERY, CONTEXT, range).then(
    (rows) => ({ ok: true as const, rows }),
    (error: unknown) => ({ ok: false as const, rejected: isQueryConcurrencyRejection(error) })
  );
}

describe("alerts query lane", () => {
  containerTestWithClickhouse(
    "an engine evaluation runs while the user lane is saturated",
    async ({ clickhouseContainer, prisma, redisOptions }) => {
      const limiter = setup(clickhouseContainer.getConnectionUrl(), prisma, redisOptions, "a");
      await hold(limiter, TENANT.project, 5);

      expect(await runOn("user")).toEqual({ ok: false, rejected: true });
      expect(await runOn("alerts")).toEqual({ ok: true, rows: [{ failures: 0 }] });
    }
  );

  containerTestWithClickhouse(
    "the alerts lane admits up to its own limit, not the caller's",
    async ({ clickhouseContainer, prisma, redisOptions }) => {
      const limiter = setup(clickhouseContainer.getConnectionUrl(), prisma, redisOptions, "b");
      const alertsKey = `alerts:${TENANT.project}`;
      await hold(limiter, alertsKey, 1);

      expect(await runOn("alerts")).toEqual({ ok: true, rows: [{ failures: 0 }] });

      await limiter.acquire({
        key: alertsKey,
        requestId: "second",
        keyLimit: 100,
        globalLimit: 100,
      });
      expect(await runOn("alerts")).toEqual({ ok: false, rejected: true });
      expect(await runOn("user")).toEqual({ ok: true, rows: [{ failures: 0 }] });
    }
  );

  containerTestWithClickhouse(
    "an alerts-lane query frees its slot when done",
    async ({ clickhouseContainer, prisma, redisOptions }) => {
      const limiter = setup(clickhouseContainer.getConnectionUrl(), prisma, redisOptions, "e");
      await hold(limiter, `alerts:${TENANT.project}`, 1);

      for (let i = 0; i < 3; i++) {
        expect(await runOn("alerts")).toEqual({ ok: true, rows: [{ failures: 0 }] });
      }
    }
  );

  containerTestWithClickhouse(
    "the alert series retries a concurrency rejection instead of plotting nothing",
    async ({ clickhouseContainer, prisma, redisOptions }) => {
      const limiter = setup(clickhouseContainer.getConnectionUrl(), prisma, redisOptions, "c");
      const held = await limiter.acquire({
        key: TENANT.project,
        requestId: "held",
        keyLimit: 1,
        globalLimit: 100,
      });
      expect(held).toEqual({ success: true });
      setTimeout(() => void limiter.release({ key: TENANT.project, requestId: "held" }), 100);

      const series = await thresholdSeries(createQueryRowRunner(1));

      expect(series.get("__agg__")).toHaveLength(3);
    }
  );

  containerTestWithClickhouse(
    "the alert series runs beside another in-flight user query",
    async ({ clickhouseContainer, prisma, redisOptions }) => {
      const limiter = setup(clickhouseContainer.getConnectionUrl(), prisma, redisOptions, "d");
      const held = await limiter.acquire({
        key: TENANT.project,
        requestId: "other_tab",
        keyLimit: 3,
        globalLimit: 100,
      });
      expect(held).toEqual({ success: true });

      const series = await thresholdSeries(createQueryRowRunner());

      expect(series.get("__agg__")).toHaveLength(3);
    }
  );
});

function thresholdSeries(runner: ReturnType<typeof createQueryRowRunner>) {
  const analysis = analyzeQueryForAlert(QUERY, { tableSchemas: querySchemas, flags: {} });
  const signal = toQuerySignal(analysis, { mode: "threshold" });
  if (!signal.ok) throw new Error(signal.message);
  const params: AlertParams = {
    environmentId: TENANT.env,
    scope: { type: "all" },
    querySignal: signal.signal,
  };
  const condition: Condition = { kind: "threshold", operator: ">", value: 0, windowSec: 3600 };
  const alert = {
    id: "alert_lane",
    organizationId: TENANT.org,
    projectId: TENANT.project,
    capabilityKey: "custom.query",
    query: QUERY,
    params,
    condition,
  };
  const until = new Date(Math.floor(Date.now() / MIN) * MIN);
  return getQueryAlertSeries(
    {
      alert,
      capability: resolveAlertCapability(alert),
      condition,
      window: { since: new Date(until.getTime() - 3 * HOUR), until },
    },
    runner
  );
}
