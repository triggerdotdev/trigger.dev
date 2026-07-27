// The two routes the dashboard agent's M3 tools fetch, driven through their REAL
// exported loaders. Container-free: only peripherals are mocked (auth, the run ->
// commit resolver, ClickHouse, Prisma), so what runs for real is each loader's own
// decision logic — param/search-param validation, the queue-name convention, the
// commit 404, and the exact JSON body the tools curate.
import { describe, expect, it, vi } from "vitest";

// --- Holders wired per-test into the mocked singletons -------------------------
const ctx = vi.hoisted(() => ({
  environment: {
    id: "env_1",
    organizationId: "org_1",
    projectId: "project_1",
    slug: "prod",
    type: "PRODUCTION",
    project: { id: "project_1", slug: "my-project", externalRef: "proj_1" },
    organization: { id: "org_1", slug: "my-org" },
  } as any,
  // resolveRunCommit's answer for the next call.
  runCommit: undefined as undefined | { sha: string; version: string; dirty: boolean },
  deployment: undefined as any,
  summaryRows: [] as any[],
  trendRows: [] as any[],
}));

vi.mock("~/env.server", async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return { ...original };
});

vi.mock("~/db.server", async () => ({
  prisma: {},
  $replica: {
    workerDeployment: {
      findFirst: async () => ctx.deployment,
    },
  },
  sqlDatabaseSchema: undefined,
}));

// The shared UAT preamble: a valid delegated token resolving to a user.
vi.mock("~/services/uatRoutePreamble.server", () => ({
  authenticateUatOrApiRequest: async () => ({
    authenticationResult: { type: "personalAccessToken", result: { userId: "user_1" } },
    userActor: { userId: "user_1", cap: ["read:runs"] },
  }),
}));

vi.mock("~/services/apiAuth.server", async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    authenticatedEnvironmentForAuthentication: async () => ctx.environment,
  };
});

// The run -> deployed-commit resolver (reads the primary + the deployment row).
vi.mock("~/services/dashboardAgent.server", () => ({
  resolveRunCommit: async () => ctx.runCommit ?? null,
}));

// Bearer/JWT auth for the api-builder route, with a permissive ability so the
// `read` on the queue_metrics query table passes.
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateBearer: async () => ({
      ok: true,
      environment: ctx.environment,
      subject: { type: "private" },
      ability: { can: () => true, canSuper: () => true },
      jwt: undefined,
    }),
  },
}));

// ClickHouse: the two queue-metric readers, returning the `[error, rows]` tuple
// the real client returns. Captures the params so we can assert the window and
// the queue name the route derived.
const chCalls = vi.hoisted(() => ({ summary: undefined as any, trend: undefined as any }));

vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: {
    getClickhouseForOrganization: async () => ({
      queueMetrics: {
        listSummary: async (params: any) => {
          chCalls.summary = params;
          return [null, ctx.summaryRows];
        },
        depthSparklines: async (params: any) => {
          chCalls.trend = params;
          return [null, ctx.trendRows];
        },
      },
    }),
  },
}));

import { loader as commitLoader } from "~/routes/api.v1.projects.$projectRef.$env.runs.$runId.commit";
import { loader as queueMetricsLoader } from "~/routes/api.v1.queues.$queueParam.metrics";

function loaderArgs(url: string, params: Record<string, string>) {
  return {
    request: new Request(url, { headers: { Authorization: "Bearer tr_uat_test" } }),
    params,
    context: {} as never,
  } as never;
}

describe("GET /api/v1/projects/:projectRef/:env/runs/:runId/commit", () => {
  it("returns the run's version, commit, and git metadata", async () => {
    ctx.runCommit = { sha: "a".repeat(40), version: "20260102.1", dirty: false };
    ctx.deployment = {
      shortCode: "abc1234",
      deployedAt: new Date("2026-01-02T09:00:00.000Z"),
      git: {
        source: "trigger_github_app",
        commitMessage: "Batch the receipt sends",
        commitAuthorName: "Ada",
        commitRef: "main",
        pullRequestNumber: 412,
        pullRequestTitle: "Batch the receipt sends",
        pullRequestState: "merged",
        // Not curated into the response.
        ghUserAvatarUrl: "https://example.invalid/avatar.png",
      },
    };

    const res = (await commitLoader(
      loaderArgs("https://app.trigger.dev/api/v1/projects/proj_1/prod/runs/run_1/commit", {
        projectRef: "proj_1",
        env: "prod",
        runId: "run_1",
      })
    )) as Response;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe("run_1");
    expect(body.version).toBe("20260102.1");
    expect(body.sha).toBe("a".repeat(40));
    expect(body.dirty).toBe(false);
    expect(body.shortCode).toBe("abc1234");
    expect(body.git).toEqual({
      source: "trigger_github_app",
      commitMessage: "Batch the receipt sends",
      commitAuthorName: "Ada",
      commitRef: "main",
      remoteUrl: undefined,
      ghUsername: undefined,
      pullRequestNumber: 412,
      pullRequestTitle: "Batch the receipt sends",
      pullRequestState: "merged",
    });
  });

  it("404s for a run with no deployed commit", async () => {
    ctx.runCommit = undefined;
    ctx.deployment = undefined;

    const res = (await commitLoader(
      loaderArgs("https://app.trigger.dev/api/v1/projects/proj_1/prod/runs/run_dev/commit", {
        projectRef: "proj_1",
        env: "prod",
        runId: "run_dev",
      })
    )) as Response;

    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/no deployed commit/);
  });

  it("400s on an unknown environment name", async () => {
    const res = (await commitLoader(
      loaderArgs("https://app.trigger.dev/api/v1/projects/proj_1/nope/runs/run_1/commit", {
        projectRef: "proj_1",
        env: "nope",
        runId: "run_1",
      })
    )) as Response;

    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/queues/:queueParam/metrics", () => {
  it("prefixes a task queue, derives throughput, and returns the depth trend", async () => {
    ctx.summaryRows = [
      {
        queue_name: "task/send-receipt",
        p50_wait_ms: 12_000,
        p95_wait_ms: 41_000,
        peak_queued: 4210,
        started_count: 600,
        throttled_count: 37,
      },
    ];
    ctx.trendRows = [
      { queue_name: "task/send-receipt", bucket: "2026-01-01 00:05:00", depth: 120, throttled: 0 },
      { queue_name: "task/send-receipt", bucket: "2026-01-01 00:00:00", depth: 10, throttled: 0 },
    ];

    const res = (await queueMetricsLoader(
      loaderArgs("https://app.trigger.dev/api/v1/queues/send-receipt/metrics?period=1h", {
        queueParam: "send-receipt",
      })
    )) as Response;

    expect(res.status).toBe(200);
    const body = await res.json();
    // `type` defaults to task, so the ClickHouse name carries the prefix.
    expect(body.queue).toBe("task/send-receipt");
    expect(chCalls.summary.queueNames).toEqual(["task/send-receipt"]);
    expect(body.waitMs).toEqual({ p50: 12_000, p95: 41_000 });
    expect(body.peakQueued).toBe(4210);
    expect(body.startedCount).toBe(600);
    // 600 starts over a 60 minute window.
    expect(body.startedPerMin).toBe(10);
    expect(body.throttledCount).toBe(37);
    // Oldest bucket first, regardless of the row order ClickHouse returned.
    expect(body.depthTrend).toEqual([10, 120]);
  });

  it("uses a custom queue's name verbatim and zeroes an unseen queue", async () => {
    ctx.summaryRows = [];
    ctx.trendRows = [];

    const res = (await queueMetricsLoader(
      loaderArgs("https://app.trigger.dev/api/v1/queues/my-queue/metrics?type=custom", {
        queueParam: "my-queue",
      })
    )) as Response;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queue).toBe("my-queue");
    expect(body.period).toBe("1h");
    expect(body.waitMs).toEqual({ p50: null, p95: null });
    expect(body.peakQueued).toBe(0);
    expect(body.startedPerMin).toBe(0);
    expect(body.depthTrend).toEqual([]);
  });

  it("keeps an already-prefixed task queue name from being double-prefixed", async () => {
    ctx.summaryRows = [];
    ctx.trendRows = [];

    const res = (await queueMetricsLoader(
      loaderArgs("https://app.trigger.dev/api/v1/queues/task%2Ffoo/metrics", {
        queueParam: "task%2Ffoo",
      })
    )) as Response;

    expect(res.status).toBe(200);
    expect((await res.json()).queue).toBe("task/foo");
  });

  it("rejects a period beyond the 7d cap", async () => {
    const res = (await queueMetricsLoader(
      loaderArgs("https://app.trigger.dev/api/v1/queues/send-receipt/metrics?period=30d", {
        queueParam: "send-receipt",
      })
    )) as Response;

    expect(res.status).toBe(400);
  });
});
