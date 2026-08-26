import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApiTools } from "./tool-api";
import { createApiClient } from "./tool-api-client";

/**
 * The agent's tools, on each environment it can be opened on. The API's env routes are
 * name-addressed and a branch shares its parent's name ("preview", "dev"), so the name identifies
 * a family and `x-trigger-branch` is what picks the row out of it. Without the branch every
 * name-addressed call resolves to the parent, and the token minted for the branch is refused
 * there — which the agent then reported to the model as "no current environment".
 *
 * Real tool path, reconstructed route: the tools, the client, the exchange and its cache are the
 * shipping code, driven through `execute` exactly as the model drives them. The server is a stub
 * that answers the way the real routes do — it resolves name + branch to a row and refuses a token
 * minted for a different one, mirroring `assertUserActorEnvironment`. The real handlers are driven
 * separately by `apps/webapp/test/uatEnvironmentClaim.test.ts` over the same wire format, which is
 * the closest the two packages can be joined: `internal-packages/dashboard-agent/src/index.ts`
 * requires webapp imports to stay type-only, so no single test can hold both halves.
 */

const ORIGIN = "https://api.example.com";
const PREVIEW_BRANCH_NAME = "feat/checkout";
const DEV_BRANCH_NAME = "katia/spike";

// What the server resolves a (name, branch) address to. A branchless name lands on the parent.
const ENVIRONMENTS: Record<string, string> = {
  "prod|": "env_prod",
  "staging|": "env_staging",
  "preview|": "env_preview_parent",
  [`preview|${PREVIEW_BRANCH_NAME}`]: "env_preview_branch",
  "dev|": "env_dev_parent",
  [`dev|${DEV_BRANCH_NAME}`]: "env_dev_branch",
};

type Call = { url: string; branch: string | null };
let calls: Call[] = [];

function resolveEnvironment(url: string, branch: string | null): string | undefined {
  const name = url.match(/\/api\/v1\/projects\/[^/]+\/([^/]+)/)?.[1];
  return ENVIRONMENTS[`${name}|${branch ?? ""}`];
}

/**
 * `tokenEnvironmentId` is the environment the delegated token was minted for. A request resolving
 * to another one is refused, the way `assertUserActorEnvironment` refuses it.
 */
function stubFetch(opts: { tokenEnvironmentId: string; jwtStatus?: () => number | undefined }) {
  return vi.fn(async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const branch = new Headers(init.headers ?? {}).get("x-trigger-branch");
    calls.push({ url, branch });

    // The env-JWT reads carry the minted JWT, not the delegated token: they address the
    // environment by id, so no branch is involved.
    if (!url.includes("/api/v1/projects/")) {
      return Response.json({ data: [] });
    }

    const resolved = resolveEnvironment(url, branch);
    if (resolved !== opts.tokenEnvironmentId) {
      return Response.json(
        { error: "This token isn't scoped to that environment.", code: "forbidden_environment" },
        { status: 403 }
      );
    }
    if (url.endsWith("/jwt")) {
      const forced = opts.jwtStatus?.();
      if (forced) return new Response("nope", { status: forced });
      return Response.json({ token: `env-jwt:${resolved}` });
    }
    return Response.json({ environmentId: resolved });
  });
}

function tools(overrides: Record<string, unknown> = {}) {
  const ctx = {
    userActorToken: "uat",
    apiOrigin: ORIGIN,
    projectRef: "proj_ref",
    ...overrides,
  };
  return buildApiTools({
    ctx,
    client: createApiClient(ctx),
    renderInvestigations: (() => []) as any,
    spanLedger: { recordTraceSpans: () => {} },
  });
}

const run = (t: ReturnType<typeof tools>, name: string, input: any = {}) =>
  (t[name] as any).execute(input, {} as any) as Promise<Record<string, any>>;

/** The four shapes an agent session can be opened on. */
const ENVIRONMENT_CASES = [
  { name: "production", environmentName: "prod", branch: undefined, id: "env_prod" },
  { name: "staging", environmentName: "staging", branch: undefined, id: "env_staging" },
  {
    name: "a preview branch",
    environmentName: "preview",
    branch: PREVIEW_BRANCH_NAME,
    id: "env_preview_branch",
    parentId: "env_preview_parent",
  },
  {
    name: "a development branch",
    environmentName: "dev",
    branch: DEV_BRANCH_NAME,
    id: "env_dev_branch",
    parentId: "env_dev_parent",
  },
];

describe.each(ENVIRONMENT_CASES)(
  "the agent's tools on $name",
  ({ environmentName, branch, id, parentId }) => {
    beforeEach(() => {
      calls = [];
      vi.stubGlobal("fetch", stubFetch({ tokenEnvironmentId: id }));
    });
    afterEach(() => vi.unstubAllGlobals());

    const ctx = () => ({ environmentName, environmentBranch: branch });

    it("reaches that exact environment", async () => {
      const result = await run(tools(ctx()), "list_runs");

      expect(result.error).toBeUndefined();
      expect(calls.find((call) => call.url.endsWith("/jwt"))!.branch).toBe(branch ?? null);
    });

    it("reaches it on the delegated-token reads too", async () => {
      const t = tools(ctx());

      const tasks = await run(t, "list_tasks");
      const commit = await run(t, "correlate_version", { runId: "run_1234" });

      expect(tasks.error).toBeUndefined();
      expect(commit.error).toBeUndefined();
      const named = calls.filter((call) => call.url.includes("/api/v1/projects/"));
      expect(named.length).toBeGreaterThan(0);
      expect(named.every((call) => call.branch === (branch ?? null))).toBe(true);
    });

    if (parentId) {
      it("is refused, not silently served the parent, when the branch is dropped", async () => {
        const result = await run(tools({ environmentName }), "list_runs");

        expect(result.error).toBe(
          "Couldn't reach the current environment to read runs from (status 403)."
        );
      });
    }
  }
);

/**
 * The failure that hid the one above: an exchange that was refused is not an environment that
 * isn't there, and the model has to be able to tell them apart. Same three-state shape the queue's
 * live read uses — only the definite case is stated definitely.
 */
describe("an environment that couldn't be reached", () => {
  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", stubFetch({ tokenEnvironmentId: "env_preview_branch" }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const branchCtx = { environmentName: "preview", environmentBranch: PREVIEW_BRANCH_NAME };

  it("says there is no environment only when none was named", async () => {
    const result = await run(tools(), "list_runs");

    expect(result.error).toBe("No current environment is available to read runs from.");
    expect(calls).toEqual([]);
  });

  it.each([
    ["read errors from", "list_errors"],
    ["read deployments from", "list_deploys"],
    ["query", "get_query_schema"],
  ])("distinguishes the two for %s", async (action, toolName) => {
    const refused = await run(tools({ environmentName: "preview" }), toolName);
    const absent = await run(tools(), toolName);

    expect(refused.error).toBe(`Couldn't reach the current environment to ${action} (status 403).`);
    expect(absent.error).toBe(`No current environment is available to ${action}.`);
  });

  it("retries a failed exchange rather than pinning the turn to it", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      stubFetch({
        tokenEnvironmentId: "env_preview_branch",
        jwtStatus: () => (attempts++ === 0 ? 500 : undefined),
      })
    );
    const t = tools(branchCtx);

    const first = await run(t, "list_runs");
    const second = await run(t, "list_runs");

    expect(first.error).toBe(
      "Couldn't reach the current environment to read runs from (status 500)."
    );
    expect(second.error).toBeUndefined();
  });
});
