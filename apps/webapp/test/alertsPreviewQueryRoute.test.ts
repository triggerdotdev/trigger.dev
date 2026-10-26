import { ClickHouse } from "@internal/clickhouse";
import { containerTestWithClickhouse } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { QueryPreviewResult } from "~/components/alerts/QueryPreviewResult";
import { RedisConcurrencyLimiter } from "~/services/redisConcurrencyLimiter.server";
import type * as DbServer from "~/db.server";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({
  ch: undefined as unknown,
  prisma: undefined as unknown as Record<string | symbol, unknown>,
  limiter: undefined as unknown,
  userId: "",
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
  DEFAULT_ORG_CONCURRENCY_LIMIT: 10,
  GLOBAL_CONCURRENCY_LIMIT: 100,
}));
vi.mock("~/services/session.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getUserId: async () => holder.userId || undefined,
}));

import { createAlert } from "~/v3/services/alerts/storage/alertStore.server";
import { previewQueryAlert } from "~/v3/services/alerts/previewQuery.server";

const MIN = 60_000;
const HOUR = 60 * MIN;
const RUNS_MATCH = "SELECT run_id, completed_at, task_identifier, queue FROM runs";

type Tenant = { org: string; project: string; env: string };
type RunSeed = {
  id: string;
  task?: string;
  queue?: string;
  triggeredAt: number;
  completedAt?: number | null;
};

function runRow(seed: RunSeed, tenant: Tenant) {
  return {
    environment_id: tenant.env,
    organization_id: tenant.org,
    project_id: tenant.project,
    run_id: `internal_${seed.id}`,
    friendly_id: seed.id,
    created_at: seed.triggeredAt,
    updated_at: seed.completedAt ?? seed.triggeredAt,
    completed_at: seed.completedAt ?? null,
    status: "COMPLETED_WITH_ERRORS",
    environment_type: "PRODUCTION",
    attempt: 1,
    engine: "V2",
    task_identifier: seed.task ?? "task-a",
    queue: seed.queue ?? "q",
    schedule_id: "",
    batch_id: "",
    tags: [],
    task_version: "20240101.1",
    sdk_version: "",
    cli_version: "",
    machine_preset: "",
    root_run_id: "",
    parent_run_id: "",
    span_id: "",
    trace_id: "",
    idempotency_key: "",
    expiration_ttl: "",
    _version: "1",
  };
}

async function insertRuns(ch: ClickHouse, seeds: RunSeed[], tenant: Tenant) {
  const [error] = await ch.writer.insertUnsafe<ReturnType<typeof runRow>>({
    name: "seed-runs",
    table: "trigger_dev.task_runs_v2",
    settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
  })(seeds.map((s) => runRow(s, tenant)));
  expect(error).toBeNull();
}

function toLimiterRedis(o: any) {
  return {
    host: o.host,
    port: o.port,
    username: o.username,
    password: o.password,
    tlsDisabled: true,
  } as never;
}

async function setup(
  clickhouseUrl: string,
  prisma: PrismaClient,
  suffix: string,
  featureFlags: Record<string, unknown> = { alertsEnabled: true },
  redis?: object
) {
  holder.limiter = redis
    ? new RedisConcurrencyLimiter({
        keyPrefix: `preview-query:${suffix}`,
        redis: toLimiterRedis(redis),
      })
    : { acquire: async () => ({ success: true }), release: async () => {} };
  holder.prisma = prisma as unknown as Record<string | symbol, unknown>;
  const ch = new ClickHouse({ url: clickhouseUrl, name: "preview-query" });
  holder.ch = ch;

  const user = await prisma.user.create({
    data: { email: `preview-query-${suffix}@example.test`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: {
      slug: `preview-query-${suffix}`,
      title: `Preview query ${suffix}`,
      featureFlags: featureFlags as never,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  const project = await prisma.project.create({
    data: {
      slug: `preview-query-${suffix}`,
      name: `Preview query ${suffix}`,
      externalRef: `preview-query-${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `preview-query-${suffix}`,
      type: "PRODUCTION",
      organizationId: organization.id,
      projectId: project.id,
      apiKey: `tr_preview_query_${suffix}`,
      pkApiKey: `pk_preview_query_${suffix}`,
      shortcode: `preview-query-${suffix}`,
    },
  });
  holder.userId = user.id;

  return {
    ch,
    tenant: { org: organization.id, project: project.id, env: environment.id },
    params: {
      organizationSlug: organization.slug,
      projectParam: project.slug,
      envParam: environment.slug,
    },
  };
}

async function call(params: Record<string, string>, body: unknown) {
  const { action } =
    await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts.preview-query");
  return action({
    request: new Request("http://localhost/alerts/preview-query", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    params,
    context: {},
  } as never);
}

async function preview(params: Record<string, string>, body: unknown) {
  const response = await call(params, body);
  return (await response.json()) as Record<string, any>;
}

async function callForStatus(params: Record<string, string>, body: unknown) {
  const response = await call(params, body).catch((thrown) => thrown as Response);
  return response.status;
}

afterEach(() => {
  vi.restoreAllMocks();
});

containerTestWithClickhouse(
  "threshold preview returns the value and wouldFire per operator and threshold",
  async ({ clickhouseContainer, prisma }) => {
    const { ch, tenant, params } = await setup(
      clickhouseContainer.getConnectionUrl(),
      prisma,
      "thr"
    );
    const now = Date.now();
    await insertRuns(
      ch,
      [
        ...[1, 2, 3].map((i) => ({ id: `run_${i}`, triggeredAt: now - 5 * MIN })),
        { id: "run_old", triggeredAt: now - 3 * HOUR },
      ],
      tenant
    );
    const base = {
      query: "SELECT count() AS total FROM runs",
      mode: "threshold",
      measure: "total",
      windowMinutes: 60,
    };

    const over = await preview(params, { ...base, operator: ">", threshold: 2 });
    expect(over).toMatchObject({ ok: true, mode: "threshold", value: 3, wouldFire: true });
    expect(over.window.minutes).toBe(60);
    expect(await preview(params, { ...base, operator: ">", threshold: 3 })).toMatchObject({
      value: 3,
      wouldFire: false,
    });
    expect(await preview(params, { ...base, operator: "<", threshold: 4 })).toMatchObject({
      wouldFire: true,
    });
    expect(await preview(params, { ...base, operator: "<", threshold: 3 })).toMatchObject({
      wouldFire: false,
    });
  }
);

containerTestWithClickhouse(
  "grouped threshold preview returns the offenders",
  async ({ clickhouseContainer, prisma }) => {
    const { ch, tenant, params } = await setup(
      clickhouseContainer.getConnectionUrl(),
      prisma,
      "grp"
    );
    const now = Date.now();
    await insertRuns(
      ch,
      [
        { id: "a1", task: "task-a", triggeredAt: now - 5 * MIN },
        { id: "a2", task: "task-a", triggeredAt: now - 5 * MIN },
        { id: "b1", task: "task-b", triggeredAt: now - 5 * MIN },
      ],
      tenant
    );

    const body = await preview(params, {
      query: "SELECT task_identifier, count() AS runs FROM runs GROUP BY task_identifier",
      mode: "threshold",
      measure: "runs",
      windowMinutes: 60,
      operator: ">",
      threshold: 1,
    });

    expect(body).toMatchObject({ ok: true, value: 2, wouldFire: true });
    expect(body.offenders).toEqual([{ key: "task-a", value: 2 }]);
  }
);

containerTestWithClickhouse(
  "match preview returns up to 10 rows and the total",
  async ({ clickhouseContainer, prisma }) => {
    const { ch, tenant, params } = await setup(
      clickhouseContainer.getConnectionUrl(),
      prisma,
      "mat"
    );
    const now = Date.now();
    await insertRuns(
      ch,
      [
        ...Array.from({ length: 15 }, (_, i) => ({
          id: `run_${String(i).padStart(2, "0")}`,
          triggeredAt: now - 40 * MIN,
          completedAt: now - 30 * MIN + i * 1000,
        })),
        { id: "run_too_old", triggeredAt: now - 5 * HOUR, completedAt: now - 4 * HOUR },
      ],
      tenant
    );

    const body = await preview(params, { query: RUNS_MATCH, mode: "match", windowMinutes: 60 });

    expect(body).toMatchObject({ ok: true, mode: "match", total: 15, wouldFire: true });
    expect(body.rows).toHaveLength(10);
    expect(body.rows[0].id).toBe("run_00");
    expect(Object.keys(body.rows[0].columns)).toEqual(["task_identifier", "queue"]);
    expect(Number.isNaN(Date.parse(body.rows[0].time))).toBe(false);
  }
);

containerTestWithClickhouse(
  "match preview with no rows would not fire",
  async ({ clickhouseContainer, prisma }) => {
    const { params } = await setup(clickhouseContainer.getConnectionUrl(), prisma, "none");

    const body = await preview(params, { query: RUNS_MATCH, mode: "match", windowMinutes: 60 });

    expect(body).toMatchObject({ ok: true, total: 0, rows: [], wouldFire: false });
  }
);

containerTestWithClickhouse(
  "an analyzer rejection returns ok:false with the message",
  async ({ clickhouseContainer, prisma }) => {
    const { params } = await setup(clickhouseContainer.getConnectionUrl(), prisma, "rej");

    const body = await preview(params, {
      query: "SELECT count() AS n FROM runs WHERE task_identifier = {{task}}",
      mode: "threshold",
      measure: "n",
      windowMinutes: 60,
      operator: ">",
      threshold: 1,
    });

    expect(body).toEqual({
      ok: false,
      reason: "Query alerts can't use {{…}} variables; replace them with fixed values.",
    });
  }
);

it("rejects a window that creating the alert would reject, without querying", async () => {
  const tenant = { organizationId: "org", projectId: "proj", environmentId: "env" };
  const runner = async () => {
    throw new Error("no query expected");
  };
  const query = "SELECT count() AS n FROM runs";

  const short = await previewQueryAlert(
    { query, mode: "threshold", measure: "n", windowMinutes: 1, operator: ">", threshold: 1 },
    tenant,
    { runner }
  );
  expect(short).toEqual({
    ok: false,
    reason: "runs needs a window of at least 10 minutes (max 24 h)",
  });
  const absence = await previewQueryAlert(
    { query, mode: "absence", measure: "n", windowMinutes: 5 },
    tenant,
    { runner }
  );
  expect(absence).toMatchObject({ ok: false });
});

const QUEUE_QUERY = {
  query: "SELECT max(max_queued) AS queued FROM concurrency_metrics",
  mode: "threshold",
  measure: "queued",
  windowMinutes: 60,
  operator: ">",
  threshold: 1,
};

containerTestWithClickhouse(
  "a source behind the queue metrics flag is rejected while the flag is off",
  async ({ clickhouseContainer, prisma }) => {
    const { params } = await setup(clickhouseContainer.getConnectionUrl(), prisma, "flag");

    const body = await preview(params, QUEUE_QUERY);

    expect(body).toEqual({
      ok: false,
      reason: `The "concurrency_metrics" table isn't available for alerts yet.`,
    });
  }
);

containerTestWithClickhouse(
  "a source behind the queue metrics flag proceeds while the flag is on",
  async ({ clickhouseContainer, prisma }) => {
    const { params } = await setup(clickhouseContainer.getConnectionUrl(), prisma, "flagon");
    const { env } = await import("~/env.server");
    vi.spyOn(env, "QUEUE_METRICS_QUERY_TABLES_VISIBLE", "get").mockReturnValue("1");

    const body = await preview(params, QUEUE_QUERY);

    expect(body.reason).toBeUndefined();
    expect(body).toMatchObject({ ok: true, mode: "threshold" });
  }
);

containerTestWithClickhouse(
  "a query ClickHouse rejects at runtime returns ok:false and is not logged as an error",
  async ({ clickhouseContainer, prisma }) => {
    const { params } = await setup(clickhouseContainer.getConnectionUrl(), prisma, "rt");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logged = (spy: typeof errorSpy) =>
      spy.mock.calls.map(([line]) => String(line)).join("\n");

    const response = await call(params, {
      query: "SELECT sum(task_identifier) AS n FROM runs",
      mode: "threshold",
      measure: "n",
      windowMinutes: 60,
      operator: ">",
      threshold: 1,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.ok).toBe(false);
    expect(body.reason).toEqual(expect.any(String));
    expect(body.reason.length).toBeGreaterThan(0);
    expect(logged(warnSpy)).toContain("ClickHouse rejected an invalid query");
    expect(logged(errorSpy)).not.toContain("Error querying clickhouse");
  }
);

containerTestWithClickhouse(
  "429 when the query lane is full",
  async ({ clickhouseContainer, prisma, redisOptions }) => {
    const { tenant, params } = await setup(
      clickhouseContainer.getConnectionUrl(),
      prisma,
      "lane",
      { alertsEnabled: true },
      redisOptions
    );
    for (let i = 0; i < 10; i++) {
      const held = await (holder.limiter as RedisConcurrencyLimiter).acquire({
        key: tenant.project,
        requestId: `held_${i}`,
        keyLimit: 10,
        globalLimit: 100,
      });
      expect(held).toEqual({ success: true });
    }

    expect(
      await callForStatus(params, { query: RUNS_MATCH, mode: "match", windowMinutes: 60 })
    ).toBe(429);
  }
);

containerTestWithClickhouse(
  "runs beside another in-flight user query",
  async ({ clickhouseContainer, prisma, redisOptions }) => {
    const { tenant, params } = await setup(
      clickhouseContainer.getConnectionUrl(),
      prisma,
      "lane-free",
      { alertsEnabled: true },
      redisOptions
    );
    const held = await (holder.limiter as RedisConcurrencyLimiter).acquire({
      key: tenant.project,
      requestId: "other_tab",
      keyLimit: 10,
      globalLimit: 100,
    });
    expect(held).toEqual({ success: true });

    expect(
      await callForStatus(params, { query: RUNS_MATCH, mode: "match", windowMinutes: 60 })
    ).toBe(200);
  }
);

containerTestWithClickhouse(
  "the dry run writes no alert state",
  async ({ clickhouseContainer, prisma }) => {
    const { ch, tenant, params } = await setup(
      clickhouseContainer.getConnectionUrl(),
      prisma,
      "dry"
    );
    const now = Date.now();
    await insertRuns(
      ch,
      [{ id: "run_1", triggeredAt: now - 40 * MIN, completedAt: now - 30 * MIN }],
      tenant
    );
    const existing = await createAlert(prisma, {
      organizationId: tenant.org,
      projectId: tenant.project,
      environmentId: tenant.env,
      capabilityKey: "queue.depth",
      params: { environmentId: tenant.env, scope: { type: "all" } },
      condition: { kind: "threshold", operator: ">", value: 1, windowSec: 300 },
      createdBy: "user_dry",
      notifiers: [],
      nextEvaluationAt: new Date(now + HOUR),
    });
    const snapshot = async () => ({
      alerts: await prisma.alert.findMany({ orderBy: { id: "asc" } }),
      events: await prisma.alertEvent.count(),
      seen: await prisma.alertOccurrenceSeen.count(),
      deliveries: await prisma.alertDelivery.count(),
    });
    const before = await snapshot();

    const matched = await preview(params, { query: RUNS_MATCH, mode: "match", windowMinutes: 60 });
    const thresholded = await preview(params, {
      query: "SELECT count() AS total FROM runs",
      mode: "threshold",
      measure: "total",
      windowMinutes: 60,
      operator: ">",
      threshold: 0,
    });

    expect(matched).toMatchObject({ ok: true, wouldFire: true });
    expect(thresholded).toMatchObject({ ok: true, wouldFire: true });
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.alerts.map((a) => a.id)).toEqual([existing.id]);
    expect(after.alerts[0]!.evaluatorState).toBeNull();
    expect(after).toMatchObject({ events: 0, seen: 0, deliveries: 0 });
  }
);

containerTestWithClickhouse(
  "403 when alerts are not enabled for the org",
  async ({ clickhouseContainer, prisma }) => {
    const { params } = await setup(clickhouseContainer.getConnectionUrl(), prisma, "off", {
      alertsEnabled: false,
    });

    expect(
      await callForStatus(params, { query: RUNS_MATCH, mode: "match", windowMinutes: 60 })
    ).toBe(403);
  }
);

containerTestWithClickhouse(
  "a user outside the organization is denied by the real authorization",
  async ({ clickhouseContainer, prisma }) => {
    const { params } = await setup(clickhouseContainer.getConnectionUrl(), prisma, "perm");
    const outsider = await prisma.user.create({
      data: { email: "preview-query-outsider@example.test", authenticationMethod: "MAGIC_LINK" },
    });
    holder.userId = outsider.id;

    const status = await callForStatus(params, {
      query: RUNS_MATCH,
      mode: "match",
      windowMinutes: 60,
    });

    expect(status).not.toBe(200);
    expect([302, 403, 404]).toContain(status);
  }
);

containerTestWithClickhouse(
  "400 on a query over 8192 characters",
  async ({ clickhouseContainer, prisma }) => {
    const { params } = await setup(clickhouseContainer.getConnectionUrl(), prisma, "long");

    expect(
      await callForStatus(params, {
        query: `SELECT ${"a".repeat(8200)}`,
        mode: "match",
        windowMinutes: 60,
      })
    ).toBe(400);
  }
);

containerTestWithClickhouse(
  "the query alert form renders a real preview response as would fire",
  async ({ clickhouseContainer, prisma }) => {
    const { ch, tenant, params } = await setup(
      clickhouseContainer.getConnectionUrl(),
      prisma,
      "form"
    );
    const now = Date.now();
    await insertRuns(
      ch,
      [1, 2, 3].map((i) => ({ id: `run_${i}`, triggeredAt: now - 5 * MIN })),
      tenant
    );

    const response = await preview(params, {
      query: "SELECT count() AS total FROM runs",
      mode: "threshold",
      measure: "total",
      windowMinutes: 60,
      operator: ">",
      threshold: 2,
    });
    const html = renderToStaticMarkup(
      createElement(QueryPreviewResult, {
        outcome: { kind: "result", response: response as never },
        detailRows: 10,
      })
    );
    expect(html).toContain("Current value: 3");
    expect(html).toContain("Would fire now");
  }
);
