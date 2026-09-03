import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodTypeAny } from "zod";
import { buildApiTools } from "./tool-api";
import { createApiClient } from "./tool-api-client";
import {
  correlateVersionSchema,
  getDeploySchema,
  getErrorSchema,
  getQuerySchemaSchema,
  getQueueSchema,
  getReportSchema,
  getRunSchema,
  getRunTraceSchema,
  listDeploysSchema,
  listErrorsSchema,
  listRunsSchema,
  listTasksSchema,
  runQuerySchema,
} from "./tool-schemas";

/**
 * The `project`/`environment` override on data lookups: the JWT exchange has to target
 * the override, not ctx, and cache per target the same way the default path does. The
 * default path (no override) must be byte-for-byte unchanged.
 */

const ORIGIN = "https://api.example.com";

type Call = { url: string; branch: string | null; body?: unknown };
let calls: Call[] = [];

function stubFetch() {
  return vi.fn(async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const branch = new Headers(init.headers ?? {}).get("x-trigger-branch");
    calls.push({ url, branch, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/jwt")) {
      // The env JWT is minted for whichever project/environment segment the exchange
      // addressed, so the token echoes it back for the assertions below.
      const match = url.match(/\/api\/v1\/projects\/([^/]+)\/([^/]+)\/jwt$/);
      return Response.json({ token: `jwt:${match![1]}/${match![2]}` });
    }
    return Response.json({ data: [] });
  });
}

function tools(overrides: Record<string, unknown> = {}) {
  const ctx = {
    userActorToken: "uat",
    apiOrigin: ORIGIN,
    projectRef: "proj_current",
    environmentName: "prod",
    ...overrides,
  };
  return buildApiTools({
    ctx,
    client: createApiClient(ctx),
    renderInvestigations: (() => []) as any,
    spanLedger: { recordTraceSpans: () => {} },
  });
}

const jwtCalls = () => calls.filter((c) => c.url.endsWith("/jwt"));

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", stubFetch());
});
afterEach(() => vi.unstubAllGlobals());

describe("the project/environment override", () => {
  it("exchanges the JWT for the overridden project and environment, not ctx's", async () => {
    const t = tools();

    await (t.list_runs as any).execute(
      { project: "proj_other", environment: "staging" },
      {} as any
    );

    expect(jwtCalls()).toHaveLength(1);
    expect(jwtCalls()[0].url).toBe(`${ORIGIN}/api/v1/projects/proj_other/staging/jwt`);
  });

  it("leaves the default path (no override) unchanged", async () => {
    const t = tools();

    await (t.list_runs as any).execute({}, {} as any);

    expect(jwtCalls()).toHaveLength(1);
    expect(jwtCalls()[0].url).toBe(`${ORIGIN}/api/v1/projects/proj_current/prod/jwt`);
  });

  it("caches the exchanged JWT per target within the turn", async () => {
    const t = tools();

    await (t.list_runs as any).execute(
      { project: "proj_other", environment: "staging" },
      {} as any
    );
    await (t.get_error as any).execute(
      { errorId: "error_1", project: "proj_other", environment: "staging" },
      {} as any
    );
    await (t.list_runs as any).execute({}, {} as any);

    // One exchange for the override target, one for the default target — never re-exchanged.
    expect(jwtCalls()).toHaveLength(2);
  });

  it("defaults environment to the current environment's name when only project is given", async () => {
    const t = tools();

    await (t.get_run as any).execute({ runId: "run_1", project: "proj_other" }, {} as any);

    expect(jwtCalls()[0].url).toBe(`${ORIGIN}/api/v1/projects/proj_other/prod/jwt`);
  });

  it("still sends x-trigger-branch on the default (no-override) path", async () => {
    const t = tools({ environmentName: "preview", environmentBranch: "feat-x" });

    await (t.list_runs as any).execute({}, {} as any);

    expect(jwtCalls()[0].branch).toBe("feat-x");
  });

  it("names the override target, not 'the current environment', when the exchange fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/jwt")) return new Response("nope", { status: 403 });
        return Response.json({ data: [] });
      })
    );
    const t = tools();

    const result = await (t.list_runs as any).execute(
      { project: "proj_other", environment: "staging" },
      {} as any
    );

    expect(result.error).toBe(
      "Couldn't reach that project/environment to read runs from (status 403)."
    );
  });
});

describe("list_projects org scoping", () => {
  // /api/v1/projects is identity-only: it lists every project the user's account
  // touches, across every org they belong to, with no per-org authorization gate.
  // The sweep's own org must be the only thing that narrows that down.
  const MULTI_ORG_PROJECTS = [
    { externalRef: "proj_same_org_a", name: "hello-world", organization: { id: "org_this" } },
    { externalRef: "proj_same_org_b", name: "other-project", organization: { id: "org_this" } },
    { externalRef: "proj_foreign", name: "hello-world", organization: { id: "org_other" } },
  ];

  function stubProjectsFetch() {
    return vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/api/v1/projects")) return Response.json(MULTI_ORG_PROJECTS);
      return Response.json({ data: [] });
    });
  }

  it("excludes a same-named project from a different org", async () => {
    vi.stubGlobal("fetch", stubProjectsFetch());
    const t = tools({ organizationId: "org_this" });

    const result = await (t.list_projects as any).execute({}, {} as any);

    expect(result.projects.map((p: { ref: string }) => p.ref)).toEqual([
      "proj_same_org_a",
      "proj_same_org_b",
    ]);
  });

  it("errors rather than returning an empty list when the turn has no organizationId", async () => {
    vi.stubGlobal("fetch", stubProjectsFetch());
    const t = tools();

    const result = await (t.list_projects as any).execute({}, {} as any);

    expect(result.projects).toBeUndefined();
    expect(result.error).toBe(
      "Couldn't determine this conversation's organization, so the project list is unavailable."
    );
  });
});

describe("the sweep survives a sibling whose environments list is inaccessible", () => {
  // The real failure this reproduces: list_environments 403s cross-project on the
  // delegated token, but the JWT exchange (env-scoped) is unrelated to it — a
  // direct project/environment lookup still works.
  function stubSweepFetch() {
    return vi.fn(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === `${ORIGIN}/api/v1/projects/proj_other/environments`) {
        return new Response("nope", { status: 403 });
      }
      if (url.endsWith("/jwt")) {
        const match = url.match(/\/api\/v1\/projects\/([^/]+)\/([^/]+)\/jwt$/);
        return Response.json({ token: `jwt:${match![1]}/${match![2]}` });
      }
      if (init.method !== "POST" && url.includes("/api/v1/queues/")) {
        return Response.json({ data: { queued: 3, paused: false } });
      }
      return Response.json({ data: [] });
    });
  }

  it("returns a structured, non-fatal shape for list_environments, and a direct sibling lookup still succeeds", async () => {
    vi.stubGlobal("fetch", stubSweepFetch());
    const t = tools();

    const envs = await (t.list_environments as any).execute(
      { projectRef: "proj_other" },
      {} as any
    );
    const queue = await (t.get_queue as any).execute(
      { queue: "my-queue", project: "proj_other", environment: "staging" },
      {} as any
    );

    expect(envs).toEqual({ inaccessible: true, projectRef: "proj_other" });
    expect(envs.error).toBeUndefined();
    expect(queue.error).toBeUndefined();
    expect(queue.exists).toBe(true);
  });
});

/**
 * Every environment-bound read, not just the ones that got the override first: a target
 * that isn't threaded reads the chat's own scope and answers about the wrong data. The
 * assertion is on the wire — each project-addressed request the tool made (the JWT
 * exchange, or a delegated-token route) has to name the target, never ctx.
 */
const ENVIRONMENT_BOUND_READS: Array<[string, { inputSchema: unknown }, Record<string, unknown>]> =
  [
    ["list_tasks", listTasksSchema, {}],
    ["list_runs", listRunsSchema, {}],
    ["get_run", getRunSchema, { runId: "run_1" }],
    ["get_run_trace", getRunTraceSchema, { runId: "run_1" }],
    ["list_errors", listErrorsSchema, {}],
    ["get_error", getErrorSchema, { errorId: "error_1" }],
    ["get_query_schema", getQuerySchemaSchema, {}],
    ["run_query", runQuerySchema, { query: "select 1" }],
    ["get_report", getReportSchema, {}],
    ["get_queue", getQueueSchema, { queue: "my-queue" }],
    ["list_deploys", listDeploysSchema, {}],
    ["get_deploy", getDeploySchema, {}],
    ["correlate_version", correlateVersionSchema, { runId: "run_1" }],
  ];

/** The (project, environment) each project-addressed request named. */
const addressed = () =>
  calls
    .map((call) => call.url.match(/\/api\/v1\/projects\/([^/]+)\/([^/?]+)/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => `${match[1]}/${match[2]}`);

describe("every environment-bound read honours the target", () => {
  it.each(ENVIRONMENT_BOUND_READS)(
    "%s reads the named project/environment",
    async (name, _schema, base) => {
      const t = tools();

      const result = await (t[name] as any).execute(
        { ...base, project: "proj_other", environment: "staging" },
        {} as any
      );

      expect(result.error).toBeUndefined();
      expect(addressed().length).toBeGreaterThan(0);
      expect([...new Set(addressed())]).toEqual(["proj_other/staging"]);
    }
  );

  it.each(ENVIRONMENT_BOUND_READS)("%s carries the named branch", async (name, _schema, base) => {
    const t = tools();

    await (t[name] as any).execute(
      { ...base, project: "proj_other", environment: "preview", branch: "feat/checkout" },
      {} as any
    );

    const named = calls.filter((call) => call.url.includes("/api/v1/projects/"));
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((call) => call.branch === "feat/checkout")).toBe(true);
  });

  it.each(ENVIRONMENT_BOUND_READS)(
    "%s accepts the target fields and stays valid without them",
    (_name, schema, base) => {
      const inputSchema = schema.inputSchema as ZodTypeAny;

      expect(
        inputSchema.safeParse({
          ...base,
          project: "proj_other",
          environment: "preview",
          branch: "feat/checkout",
        }).success
      ).toBe(true);
      expect(inputSchema.safeParse(base).success).toBe(true);
    }
  );
});

describe("run_query's POST", () => {
  it("goes out on the target's JWT, not the chat environment's", async () => {
    const t = tools();

    await (t.run_query as any).execute(
      { query: "select 1", project: "proj_other", environment: "staging" },
      {} as any
    );

    expect(jwtCalls()[0].url).toBe(`${ORIGIN}/api/v1/projects/proj_other/staging/jwt`);
    const query = calls.find((call) => call.url.endsWith("/api/v1/query"));
    expect(query).toBeDefined();
    expect(query!.body).toMatchObject({ query: "select 1", scope: "environment" });
  });

  it("still uses the chat environment's JWT with no target", async () => {
    const t = tools();

    await (t.run_query as any).execute({ query: "select 1" }, {} as any);

    expect(jwtCalls()[0].url).toBe(`${ORIGIN}/api/v1/projects/proj_current/prod/jwt`);
  });
});

describe("a project the org doesn't have", () => {
  // Client hygiene only, on what list_projects already reported this turn: the answer
  // to a foreign target is a plain tool error rather than a pointless exchange.
  function stubOrgFetch() {
    return vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, branch: null });
      if (url.endsWith("/api/v1/projects")) {
        return Response.json([
          { externalRef: "proj_current", name: "current", organization: { id: "org_this" } },
          { externalRef: "proj_other", name: "other", organization: { id: "org_this" } },
        ]);
      }
      if (url.endsWith("/jwt")) return Response.json({ token: "jwt" });
      return Response.json({ data: [] });
    });
  }

  it("is refused without an exchange once list_projects has run", async () => {
    vi.stubGlobal("fetch", stubOrgFetch());
    const t = tools({ organizationId: "org_this" });
    await (t.list_projects as any).execute({}, {} as any);

    const result = await (t.list_runs as any).execute({ project: "proj_nope" }, {} as any);

    expect(result.error).toBe(
      "No project proj_nope in this organization. Call list_projects to see what exists."
    );
    expect(jwtCalls()).toHaveLength(0);
  });

  it("is attempted anyway when nothing is known about the org's projects", async () => {
    const t = tools();

    await (t.list_runs as any).execute({ project: "proj_nope" }, {} as any);

    expect(jwtCalls()[0].url).toBe(`${ORIGIN}/api/v1/projects/proj_nope/prod/jwt`);
  });
});
