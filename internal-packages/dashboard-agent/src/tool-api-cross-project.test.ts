import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRepoTools, workdirFor, type RepoSnapshot } from "./repo-tools";
import { buildApiTools } from "./tool-api";
import { createApiClient } from "./tool-api-client";
import { canonicalizeInvestigationState } from "./tool-evidence";
import { createSourceReadLedger } from "./tool-source-ledger";
import { buildDashboardAgentTools } from "./tools";

/**
 * Every environment-bound tool can be aimed at another project, environment or branch of the
 * organization, in the same turn as the conversation's own. The target is the model's to name, so
 * each field is checked against its own format and each path segment is escaped; the branch rides
 * `x-trigger-branch` and never the path. Authorization stays the server's — this only fixes what
 * the request can address.
 */

const ORIGIN = "https://api.example.com";
const CONVERSATION = {
  organizationId: "org_1",
  projectRef: "proj_hereherehereherehere",
  environmentName: "dev",
};

const OTHER_REF = "proj_otherotherotherother";

// What `GET /api/v1/projects` answers with: the org's projects, two of them sharing a name.
const PROJECTS = [
  { externalRef: OTHER_REF, slug: "other-project", name: "OtherProject" },
  { externalRef: "proj_twinaaaaaaaaaaaaaa", slug: "twin-a", name: "Twin" },
  { externalRef: "proj_twinbbbbbbbbbbbbbb", slug: "twin-b", name: "Twin" },
].map((project) => ({ ...project, organization: { id: "org_1", title: "Org" } }));

type Call = { url: string; branch: string | null };
let calls: Call[] = [];
let fetchStub: ReturnType<typeof vi.fn>;

function stubFetch(handle?: (url: string) => Response | undefined) {
  return vi.fn(async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, branch: new Headers(init.headers ?? {}).get("x-trigger-branch") });
    const answer = handle?.(url);
    if (answer) return answer;
    if (url.endsWith("/jwt")) return Response.json({ token: `jwt:${url}`, environmentId: "env_1" });
    if (url.endsWith("/api/v1/projects")) return Response.json(PROJECTS);
    return Response.json({ data: [], results: [], tables: [] });
  });
}

function toolsFor(ctx: Record<string, unknown>) {
  const full = { userActorToken: "uat", apiOrigin: ORIGIN, ...ctx };
  return buildApiTools({
    ctx: full,
    client: createApiClient(full),
    renderInvestigations: (() => []) as any,
  });
}

const run = (name: string, input: any) =>
  (toolsFor(CONVERSATION)[name] as any).execute(input, {} as any) as Promise<Record<string, any>>;

const OTHER = { project: OTHER_REF, environment: "prod" };
// A conversation whose own environment is a preview branch.
const previewTools = () =>
  toolsFor({
    projectRef: "proj_hereherehereherehere",
    environmentName: "preview",
    environmentBranch: "feat/current",
  });
const paths = () => calls.filter((call) => !call.url.endsWith("/jwt")).map((call) => call.url);

beforeEach(() => {
  calls = [];
  fetchStub = stubFetch();
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => vi.unstubAllGlobals());

/**
 * Every tool that takes a target: the input it needs besides one, and the exact data path it
 * must request when aimed at the other project's prod. A tool may make further reads (get_queue tries both
 * queue kinds), but the path below is the read the tool exists for.
 */
const ENV_BOUND_TOOLS: Array<[string, Record<string, unknown>, string]> = [
  ["list_tasks", {}, "/api/v1/projects/proj_otherotherotherother/prod/workers/current"],
  ["list_runs", {}, "/api/v1/runs?page%5Bsize%5D=10"],
  ["get_run", { runId: "run_1" }, "/api/v3/runs/run_1"],
  ["get_run_trace", { runId: "run_1" }, "/api/v1/runs/run_1/trace"],
  ["list_errors", {}, "/api/v1/errors?page%5Bsize%5D=20"],
  ["get_error", { errorId: "error_1" }, "/api/v1/errors/error_1"],
  ["get_query_schema", {}, "/api/v1/query/schema"],
  ["run_query", { query: "select 1" }, "/api/v1/query"],
  ["get_report", {}, "/api/v1/reports/health?format=json"],
  ["get_queue", { queue: "email-sends" }, "/api/v1/queues/email-sends/metrics?type=task"],
  ["list_deploys", {}, "/api/v1/deployments?page%5Bsize%5D=10"],
  ["get_deploy", {}, "/api/v1/deployments/current"],
  [
    "correlate_version",
    { runId: "run_1" },
    "/api/v1/projects/proj_otherotherotherother/prod/runs/run_1/commit",
  ],
];

describe.each(ENV_BOUND_TOOLS)("%s aimed at another environment", (name, input, dataPath) => {
  it("requests its own path, addressed at the project and environment it was given", async () => {
    const result = await run(name, { ...input, ...OTHER });

    expect(result.error).toBeUndefined();
    expect(paths()).toContain(`${ORIGIN}${dataPath}`);
    // Nothing leaks back to the conversation's own scope, on any call of the turn.
    expect(calls.every((call) => !call.url.includes("proj_hereherehereherehere"))).toBe(true);
    const named = calls.filter((call) => call.url.includes("/api/v1/projects/"));
    expect(
      named.every((call) =>
        call.url.startsWith(`${ORIGIN}/api/v1/projects/proj_otherotherotherother/prod/`)
      )
    ).toBe(true);
  });

  it("carries the branch on the name-addressed calls and never in a path", async () => {
    await run(name, { ...input, ...OTHER, branch: "feat/a" });

    for (const call of calls) {
      // Only the name-addressed routes resolve by branch; the env-JWT reads address by id.
      const named = call.url.includes("/api/v1/projects/");
      expect(call.branch).toBe(named ? "feat/a" : null);
      expect(call.url).not.toContain("feat");
    }
  });

  it.each([
    ["project", { project: "P2/../admin", environment: "prod" }],
    ["project with a percent escape", { project: "P2%2fadmin", environment: "prod" }],
    ["environment", { project: "proj_otherotherotherother", environment: "prod?x=1" }],
    [
      "branch",
      { project: "proj_otherotherotherother", environment: "prod", branch: "feat/../main" },
    ],
    ["empty project", { project: "", environment: "prod" }],
    ["empty environment", { project: "proj_otherotherotherother", environment: "" }],
    ["empty branch", { project: "proj_otherotherotherother", environment: "prod", branch: "" }],
  ])("rejects an invalid %s without making a request", async (_field, target) => {
    const result = await run(name, { ...input, ...target });

    expect(result.error).toBeTruthy();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

/** Refs in the wild aren't all generator-shaped: seeded ones carry their own layout. */
describe.each(["proj_seed_49_cle7coz4", "proj_agentexamplesseed01"])("a %s ref", (projectRef) => {
  it("is addressable", async () => {
    const result = await run("list_runs", { project: projectRef, environment: "prod" });

    expect(result.error).toBeUndefined();
    expect(calls.map((call) => call.url)).toContain(
      `${ORIGIN}/api/v1/projects/${projectRef}/prod/jwt`
    );
  });
});

/**
 * Models name a project the way the dashboard shows it, so a slug has to resolve to its ref.
 * Guessing wrong is worse than erroring: reading the conversation's project instead answers
 * "that queue doesn't exist" about an environment nobody asked about.
 */
describe("a project named by slug", () => {
  it("resolves to its ref, and the reads target that", async () => {
    const result = await run("list_runs", { project: "other-project", environment: "prod" });

    expect(result.error).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      `${ORIGIN}/api/v1/projects`,
      `${ORIGIN}/api/v1/projects/${OTHER_REF}/prod/jwt`,
      `${ORIGIN}/api/v1/runs?page%5Bsize%5D=10`,
    ]);
  });

  // A name is matched case-insensitively; one with whitespace never reaches the lookup.
  it("resolves by name too, when no slug matches", async () => {
    await run("list_runs", { project: "otherproject", environment: "prod" });

    expect(calls.map((call) => call.url)).toContain(
      `${ORIGIN}/api/v1/projects/${OTHER_REF}/prod/jwt`
    );
  });

  it.each(["nope-nope", "P2"])("%s reaches no environment at all", async (project) => {
    const result = await run("list_runs", { project, environment: "prod" });

    expect(result.error).toContain("No project");
    expect(result.error).toContain("other-project");
    expect(calls.map((call) => call.url)).toEqual([`${ORIGIN}/api/v1/projects`]);
  });

  it("is refused when the name matches two projects", async () => {
    const result = await run("list_runs", { project: "Twin", environment: "prod" });

    expect(result.error).toContain("matches more than one project");
    expect(calls.map((call) => call.url)).toEqual([`${ORIGIN}/api/v1/projects`]);
  });

  it("is looked up once per turn, however many tools ask", async () => {
    const t = toolsFor(CONVERSATION);
    const call = (name: string, input: any) => (t[name] as any).execute(input, {} as any);

    await call("list_runs", { project: "other-project", environment: "prod" });
    await call("list_errors", { project: "other-project", environment: "prod" });

    expect(calls.filter((c) => c.url.endsWith("/api/v1/projects"))).toHaveLength(1);
  });
});

/** An answer has to say which project and environment it checked, or "not found" misleads. */
describe("the scope an answer was read from", () => {
  it.each(["get_queue", "list_tasks"])("%s names it", async (name) => {
    const result = await run(name, {
      queue: "q-plain",
      project: "other-project",
      environment: "prod",
    });

    expect(result.project).toEqual({ ref: OTHER_REF, slug: "other-project" });
    expect(result.environment).toEqual({ name: "prod" });
  });

  it("carries the branch it read, and the ref alone when that is all it was given", async () => {
    const result = await run("get_queue", {
      queue: "q-plain",
      project: OTHER_REF,
      environment: "preview",
      branch: "feat/a",
    });

    expect(result.project).toEqual({ ref: OTHER_REF });
    expect(result.environment).toEqual({ name: "preview", branch: "feat/a" });
  });
});

/**
 * A listed id the model can't link is an id it writes out bare, so every row of a list
 * carries the uri of the scope its row was read from.
 */
describe("the rows of a list", () => {
  const ROWS = {
    "/api/v1/runs": { data: [{ id: "run_1" }, { id: "run_2" }] },
    "/api/v1/errors": { data: [{ id: "error_abc" }] },
    "/api/v1/deployments": { data: [{ id: "deployment_1", version: "20260101.1" }] },
  };

  beforeEach(() => {
    fetchStub = stubFetch((url) => {
      if (url.endsWith("/jwt")) {
        return Response.json({
          token: "jwt",
          environmentId: url.includes(OTHER_REF) ? "env_other" : "env_here",
        });
      }
      const rows = Object.entries(ROWS).find(([path]) => url.includes(path));
      return rows ? Response.json(rows[1]) : undefined;
    });
    vi.stubGlobal("fetch", fetchStub);
  });
  it("each carry the uri of the conversation's own environment", async () => {
    const runs = await run("list_runs", {});
    const errors = await run("list_errors", {});
    const deploys = await run("list_deploys", {});

    const ref = CONVERSATION.projectRef;
    expect(runs.runs.map((r: any) => r.uri)).toEqual([
      `trigger://${ref}/env_here/run/run_1`,
      `trigger://${ref}/env_here/run/run_2`,
    ]);
    expect(errors.errors[0].uri).toBe(`trigger://${ref}/env_here/error/abc`);
    expect(deploys.deploys[0].uri).toBe(`trigger://${ref}/env_here/deployment/20260101.1`);
  });

  it("carry the sibling's environment when the list was aimed there", async () => {
    const runs = await run("list_runs", { project: "other-project", environment: "prod" });

    expect(runs.runs.map((r: any) => r.uri)).toEqual([
      `trigger://${OTHER_REF}/env_other/run/run_1`,
      `trigger://${OTHER_REF}/env_other/run/run_2`,
    ]);
  });

  it("are never served uri-less: an exchange that carried no id never landed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/jwt")) return Response.json({ token: "jwt" });
        return Response.json(ROWS["/api/v1/runs"]);
      })
    );

    const runs = await run("list_runs", {});

    expect(runs.error).toContain("Couldn't reach");
  });
});

/**
 * Mid-deploy the webapp answering the exchange can be the old one, whose response carries no
 * environmentId. The panel already knows its own environment, so the conversation's reads go
 * on working; a sibling target has nothing to stand in for it and stays unreachable.
 */
describe("an exchange that answered without an environment id", () => {
  const PANEL_ENV = "env_panel";

  function toolsWithPanelEnv() {
    const ctx = {
      userActorToken: "uat",
      apiOrigin: ORIGIN,
      ...CONVERSATION,
      environmentId: PANEL_ENV,
    };
    return buildApiTools({
      ctx,
      client: createApiClient(ctx),
      renderInvestigations: (() => []) as any,
    });
  }

  beforeEach(() => {
    calls = [];
    fetchStub = vi.fn(async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, branch: new Headers(init.headers ?? {}).get("x-trigger-branch") });
      if (url.endsWith("/api/v1/projects")) return Response.json(PROJECTS);
      if (url.endsWith("/jwt")) return Response.json({ token: "legacy-jwt" });
      return Response.json({ data: [{ id: "run_1" }] });
    });
    vi.stubGlobal("fetch", fetchStub);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("still serves the conversation's own environment, at the id the panel holds", async () => {
    const result = await (toolsWithPanelEnv().list_runs as any).execute({}, {} as any);

    expect(result.error).toBeUndefined();
    expect(result.runs[0].uri).toBe(`trigger://${CONVERSATION.projectRef}/${PANEL_ENV}/run/run_1`);
  });

  it("leaves a sibling target unreachable rather than guessing its environment", async () => {
    const result = await (toolsWithPanelEnv().list_runs as any).execute(
      { project: "other-project", environment: "prod" },
      {} as any
    );

    expect(result.error).toBe("Couldn't reach the current environment to read runs from.");
    expect(calls.every((call) => !call.url.startsWith(`${ORIGIN}/api/v1/runs`))).toBe(true);
  });

  /**
   * One field apart at a time: the panel's id stands in for its own environment and for
   * nothing adjacent to it, so the match has to hold field by field rather than as a family.
   */
  const PREVIEW = { environmentName: "preview", environmentBranch: "feat/current" };

  it.each([
    ["the conversation's own environment", {}, {}, PANEL_ENV],
    [
      "the same project, environment and branch, named explicitly",
      PREVIEW,
      { project: CONVERSATION.projectRef, environment: "preview", branch: "feat/current" },
      PANEL_ENV,
    ],
    ["a conversation branch held as an empty string", { environmentBranch: "" }, {}, PANEL_ENV],
    ["another environment of the same project", {}, { environment: "prod" }, null],
    ["another branch of the same environment", PREVIEW, { branch: "feat/other" }, null],
  ])("%s", async (_case, ctxOverrides, input, environmentId) => {
    const tools = toolsFor({
      ...CONVERSATION,
      environmentId: PANEL_ENV,
      ...(ctxOverrides as object),
    });

    const result = await (tools.list_runs as any).execute(input, {} as any);

    if (environmentId) {
      expect(result.error).toBeUndefined();
      expect(result.runs[0].uri).toBe(
        `trigger://${CONVERSATION.projectRef}/${environmentId}/run/run_1`
      );
    } else {
      expect(result.error).toBe("Couldn't reach the current environment to read runs from.");
      expect(paths()).toEqual([]);
    }
  });
});

describe("an id that isn't in the scope it was looked for in", () => {
  beforeEach(() => {
    fetchStub = stubFetch((url) =>
      url.endsWith("/api/v1/projects") || url.endsWith("/jwt")
        ? undefined
        : new Response("nope", { status: 404 })
    );
    vi.stubGlobal("fetch", fetchStub);
  });
  it.each([
    ["get_run", { runId: "run_1" }, "Run run_1"],
    ["get_run_trace", { runId: "run_1" }, "Run run_1"],
    ["get_error", { errorId: "error_1" }, "Error error_1"],
  ])("%s says where it looked and to locate it", async (name, input, subject) => {
    const own = await run(name, input);
    const other = await run(name, { ...input, project: "other-project", environment: "prod" });

    expect(own.error).toBe(
      `${subject} not found in ${CONVERSATION.projectRef}/dev; call locate to find it in the organization.`
    );
    expect(other.error).toBe(
      `${subject} not found in other-project/prod; call locate to find it in the organization.`
    );
  });

  it("still reports a failed read as a failed read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/jwt")) return Response.json({ token: "jwt", environmentId: "env_1" });
        return new Response("boom", { status: 503 });
      })
    );

    const result = await run("get_run", { runId: "run_1" });

    expect(result.error).toContain("status 503");
    expect(result.error).not.toContain("locate");
  });
});

describe("a model-supplied id inside a retargeted path", () => {
  it("is escaped, so an already-escaped id can't decode into another route", async () => {
    await run("get_run", { runId: "run_%2f..%2fadmin", ...OTHER });

    expect(paths()).toEqual([`${ORIGIN}/api/v3/runs/run_%252f..%252fadmin`]);
  });
});

describe("a preview environment is addressed by name plus branch", () => {
  it("is refused, rather than silently read as the parent, when no branch is named", async () => {
    const result = await run("list_runs", {
      project: "proj_otherotherotherother",
      environment: "preview",
    });

    expect(result.error).toContain("Name the branch");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("is refused when the name is inherited and only the project was retargeted", async () => {
    const t = previewTools();

    const result = await (t.list_runs as any).execute(
      { project: "proj_otherotherotherother" },
      {} as any
    );

    expect(result.error).toContain("Name the branch");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("keeps the conversation's own branch when that is the environment named", async () => {
    const t = previewTools();

    await (t.list_runs as any).execute({ environment: "preview" }, {} as any);

    const exchange = calls.find((call) => call.url.endsWith("/jwt"))!;
    expect(exchange.url).toBe(`${ORIGIN}/api/v1/projects/proj_hereherehereherehere/preview/jwt`);
    expect(exchange.branch).toBe("feat/current");
  });
});

describe("two targets in one turn", () => {
  it("exchanges one JWT per target rather than reusing the first", async () => {
    const t = toolsFor(CONVERSATION);
    const call = (input: unknown) => (t.list_runs as any).execute(input, {} as any);

    await call({});
    await call({ project: "proj_otherotherotherother", environment: "prod" });
    await call({ environment: "preview", branch: "feat/a" });
    // The same target again shares the cached exchange.
    await call({ project: "proj_otherotherotherother", environment: "prod" });

    const exchanges = calls.filter((c) => c.url.endsWith("/jwt")).map((c) => c.url);
    expect(exchanges).toHaveLength(3);
    expect(new Set(exchanges).size).toBe(3);
    expect(exchanges).toContain(`${ORIGIN}/api/v1/projects/proj_hereherehereherehere/dev/jwt`);
    expect(exchanges).toContain(`${ORIGIN}/api/v1/projects/proj_otherotherotherother/prod/jwt`);
    expect(exchanges).toContain(`${ORIGIN}/api/v1/projects/proj_hereherehereherehere/preview/jwt`);
  });

  it("doesn't lend the conversation's branch to another environment", async () => {
    const t = previewTools();

    await (t.list_runs as any).execute({ environment: "prod" }, {} as any);

    const exchange = calls.find((c) => c.url.endsWith("/jwt"))!;
    expect(exchange.url).toBe(`${ORIGIN}/api/v1/projects/proj_hereherehereherehere/prod/jwt`);
    expect(exchange.branch).toBeNull();
  });
});

/**
 * The source tools resolve the commit to read from the run's own deployed version, so a
 * cross-project source read is addressed by the snapshot route of the target environment.
 */
describe("the source tools", () => {
  const SNAPSHOT = {
    tarballUrl: "https://codeload.github.com/acme/demo/tar.gz/deadbeef",
    owner: "acme",
    repo: "demo",
    sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  };
  const sourceTools = () =>
    buildDashboardAgentTools({
      userActorToken: "uat",
      apiOrigin: ORIGIN,
      ...CONVERSATION,
      repoSnapshot: SNAPSHOT,
    });
  const call = (name: string, input: any) => (sourceTools()[name] as any).execute(input, {} as any);

  const SOURCE_TOOLS: Array<[string, Record<string, unknown>]> = [
    ["get_repo_info", {}],
    ["list_files", {}],
    ["read_file", { path: "README.md" }],
    ["search_code", { query: "LIMIT" }],
  ];

  it.each(SOURCE_TOOLS)(
    "%s reads the snapshot of the environment it was given",
    async (name, input) => {
      await call(name, { ...input, ...OTHER, runId: "run_1", branch: "feat/a" });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        `${ORIGIN}/api/v1/projects/proj_otherotherotherother/prod/repo/snapshot?runId=run_1`
      );
      expect(calls[0].branch).toBe("feat/a");
    }
  );

  it.each(SOURCE_TOOLS)(
    "%s rejects an invalid target without making a request",
    async (name, input) => {
      const result = await call(name, { ...input, project: "P2/../admin", runId: "run_1" });

      expect(result.error).toBeTruthy();
      expect(fetchStub).not.toHaveBeenCalled();
    }
  );

  it.each(SOURCE_TOOLS)(
    "%s won't read another environment off the current repo",
    async (name, input) => {
      const result = await call(name, { ...input, ...OTHER });

      expect(result.error).toContain("runId");
      expect(fetchStub).not.toHaveBeenCalled();
    }
  );
});

/**
 * The read tools attach a ready-made `trigger://` URI so the model has something to
 * paste into a citation rather than assemble from raw ids. The URI is built from the
 * RESOLVED target's environment id — P2/prod here — never the conversation's own.
 */
describe("curated objects carry a ready-made evidence uri", () => {
  function uriStub() {
    return stubFetch((url) => {
      if (url.endsWith("/jwt")) {
        // Derived from the requested path, not a constant: an untargeted call and a
        // sibling-target call must resolve to genuinely different environment ids,
        // or a test asserting "the conversation's own" can't tell them apart.
        const match = url.match(/\/projects\/([^/]+)\/([^/]+)\/jwt$/);
        const environmentId = match ? `env_${match[1]}_${match[2]}` : "env_unknown";
        return Response.json({ token: `jwt:${url}`, environmentId });
      }
      if (url.endsWith("/api/v3/runs/run_1")) {
        return Response.json({ id: "run_1", status: "COMPLETED" });
      }
      if (url.endsWith("/runs/run_1/trace")) {
        return Response.json({
          trace: {
            traceId: "trace_1",
            rootSpan: { id: "span_1", data: { message: "root" } },
          },
        });
      }
      if (url.endsWith("/errors/error_1")) {
        return Response.json({ id: "error_1", errorType: "Error" });
      }
      if (url.includes("/queues/email-sends/metrics")) {
        return Response.json({ peakQueued: 5, startedCount: 1, throttledCount: 0 });
      }
      if (url.includes("/queues/email-sends?type=")) {
        return Response.json({ data: { paused: false, queued: 0, running: 0 } });
      }
      if (url.includes("/reports/health")) {
        return Response.json({ flow: { severity: "ok" } });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
  }

  beforeEach(() => {
    fetchStub = uriStub();
    vi.stubGlobal("fetch", fetchStub);
  });

  const SCOPE = "proj_otherotherotherother/env_proj_otherotherotherother_prod";

  it.each([
    ["get_run", { runId: "run_1", ...OTHER }, `trigger://${SCOPE}/run/run_1`],
    ["get_error", { errorId: "error_1", ...OTHER }, `trigger://${SCOPE}/error/1`],
    ["get_queue", { queue: "email-sends", ...OTHER }, `trigger://${SCOPE}/queue/email-sends`],
    ["get_report", { ...OTHER }, `trigger://${SCOPE}/report/health`],
  ])("%s attaches a uri scoped to P2/prod", async (name, input, uri) => {
    const result = await run(name, input);
    expect(result.uri).toBe(uri);
  });

  it("attaches a uri scoped to P2/prod on each span of get_run_trace", async () => {
    const result = await run("get_run_trace", { runId: "run_1", ...OTHER });
    expect(result.spans[0].uri).toBe(
      "trigger://proj_otherotherotherother/env_proj_otherotherotherother_prod/run/run_1/span/span_1"
    );
  });

  it("keeps the conversation's own scope on get_report when untargeted", async () => {
    const result = await run("get_report", {});
    expect(result.uri).toBe(
      "trigger://proj_hereherehereherehere/env_proj_hereherehereherehere_dev/report/health"
    );
  });
});

/**
 * A source read of a sibling project has to be recorded at the commit and environment it was
 * actually served from. The reader resolves the slug; when the ledger re-resolved it instead,
 * the read was filed under the conversation's own commit and every citation of it fell back
 * to the conversation's scope — the failure this whole change exists to remove.
 */
describe("a source read from a sibling project", () => {
  const DEFAULT_SNAPSHOT: RepoSnapshot = {
    tarballUrl: "http://unused.invalid/never-fetched",
    owner: "acme",
    repo: "demo",
    sha: "a".repeat(40),
  };
  const SIBLING_SNAPSHOT: RepoSnapshot = { ...DEFAULT_SNAPSHOT, sha: "b".repeat(40) };
  const PATH = "src/trigger/order.ts";
  const SIBLING_ENV = "env_other_prod";
  const CONVERSATION_ENV = "env_here";

  // Pre-seeded workspaces, so `ensureWorkspace` serves both commits without any fetch.
  beforeAll(async () => {
    for (const snapshot of [DEFAULT_SNAPSHOT, SIBLING_SNAPSHOT]) {
      const dir = workdirFor(snapshot);
      await mkdir(join(dir, "src/trigger"), { recursive: true });
      await writeFile(join(dir, PATH), `const LIMIT = ${snapshot.sha[0]};\n`);
      await writeFile(join(dir, ".ready"), snapshot.sha);
    }
  });
  afterAll(async () => {
    for (const snapshot of [DEFAULT_SNAPSHOT, SIBLING_SNAPSHOT]) {
      await rm(workdirFor(snapshot), { recursive: true, force: true });
    }
  });

  function sourceTools() {
    const ctx = {
      userActorToken: "uat",
      apiOrigin: ORIGIN,
      ...CONVERSATION,
      repoSnapshot: DEFAULT_SNAPSHOT,
    };
    const client = createApiClient(ctx);
    const ledger = createSourceReadLedger({
      origin: client.origin,
      hasAuth: client.hasAuth,
      userActorToken: ctx.userActorToken,
      projectRef: ctx.projectRef,
      environmentName: ctx.environmentName,
      repoSnapshot: ctx.repoSnapshot,
      environmentIdFor: client.environmentIdFor,
    });
    const tools = buildRepoTools(DEFAULT_SNAPSHOT, ctx, {
      resolveRunSnapshot: ledger.resolveRunSnapshot,
      onSourceRead: ledger.recordRepoRead,
    });
    return { ledger, read: (input: any) => (tools.read_file as any).execute(input, {} as any) };
  }

  const citeSource = (sha: string, ledger: any) =>
    canonicalizeInvestigationState(
      {
        outcome: "in_progress",
        severity: "low",
        confidence: "low",
        title: "t",
        headline: "h",
        evidence: [{ kind: "source", path: PATH, sha, label: "the code" }],
        hypotheses: [],
      } as any,
      { projectRef: CONVERSATION.projectRef, environmentId: CONVERSATION_ENV },
      ledger
    );

  // The exchange is what names the environment a read is scoped to; it can fail on its own.
  let exchangeFails = false;

  beforeEach(() => {
    exchangeFails = false;
    fetchStub = stubFetch((url) => {
      if (url.includes("/repo/snapshot")) return Response.json(SIBLING_SNAPSHOT);
      if (url.endsWith("/jwt")) {
        if (exchangeFails) return new Response("nope", { status: 500 });
        return Response.json({
          token: "jwt",
          environmentId: url.includes(OTHER_REF) ? SIBLING_ENV : CONVERSATION_ENV,
        });
      }
      return undefined;
    });
    vi.stubGlobal("fetch", fetchStub);
  });
  it("is filed at the sibling's commit, and a citation canonicalizes to its scope", async () => {
    const { ledger, read } = sourceTools();

    const result = await read({
      path: PATH,
      project: "other-project",
      environment: "prod",
      runId: "run_9",
    });

    expect(result.error).toBeUndefined();
    expect(calls.map((call) => call.url)).toContain(
      `${ORIGIN}/api/v1/projects/${OTHER_REF}/prod/repo/snapshot?runId=run_9`
    );
    // The sibling's commit, not the conversation's default-branch one.
    expect(ledger.wasReadThisTurn(PATH, SIBLING_SNAPSHOT.sha)).toBe(true);
    expect(ledger.wasReadThisTurn(PATH, DEFAULT_SNAPSHOT.sha)).toBe(false);
    expect(ledger.scopesForSourceRead(PATH, SIBLING_SNAPSHOT.sha)).toEqual([
      { projectRef: OTHER_REF, environmentId: SIBLING_ENV, environmentName: "prod" },
    ]);

    const { state, errors } = citeSource(SIBLING_SNAPSHOT.sha, ledger);

    expect(errors).toEqual([]);
    expect(state.evidence[0]!.uri).toBe(
      `trigger://${OTHER_REF}/${SIBLING_ENV}/source/${SIBLING_SNAPSHOT.sha}/${PATH}`
    );
  });

  /**
   * The scope can fail to resolve after the file has already been read. Recording the read
   * anyway would leave it citable with no scope, and a citation of it would be stamped with
   * the conversation's environment — a source line attributed to the wrong environment.
   */
  it("is not recorded at all when its environment couldn't be named", async () => {
    exchangeFails = true;
    const { ledger, read } = sourceTools();

    const result = await read({
      path: PATH,
      project: "other-project",
      environment: "prod",
      runId: "run_9",
    });

    expect(result.error).toBeUndefined();
    expect(ledger.wasReadThisTurn(PATH, SIBLING_SNAPSHOT.sha)).toBe(false);
    expect(ledger.shaForReadPath(PATH)).toBeUndefined();

    const { errors } = citeSource(SIBLING_SNAPSHOT.sha, ledger);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("read_file it at that commit");
  });

  // The other half: an untargeted read is the conversation's own, and stays citable.
  it("is recorded under the conversation's scope when no target was named", async () => {
    const { ledger, read } = sourceTools();

    const result = await read({ path: PATH });

    expect(result.error).toBeUndefined();
    expect(ledger.wasReadThisTurn(PATH, DEFAULT_SNAPSHOT.sha)).toBe(true);
    expect(ledger.scopesForSourceRead(PATH, DEFAULT_SNAPSHOT.sha)).toEqual([
      {
        projectRef: CONVERSATION.projectRef,
        environmentId: CONVERSATION_ENV,
        environmentName: CONVERSATION.environmentName,
      },
    ]);
  });

  /**
   * The deliberate fail-open half: the conversation's own snapshot is the one already
   * extracted for this turn, so a read of it stays citable even when the exchange that
   * names its environment fails. Only the scope is missing, never the read.
   */
  it("stays recorded when no target was named and the exchange failed", async () => {
    exchangeFails = true;
    const { ledger, read } = sourceTools();

    await read({ path: PATH });

    expect(ledger.wasReadThisTurn(PATH, DEFAULT_SNAPSHOT.sha)).toBe(true);
    expect(ledger.scopesForSourceRead(PATH, DEFAULT_SNAPSHOT.sha)).toEqual([]);
  });
});
