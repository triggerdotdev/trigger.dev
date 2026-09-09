import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./tool-api-client";
import { buildLocateTool } from "./tool-locate";
import { createSourceReadLedger, type SourceReadLedger } from "./tool-source-ledger";
import { buildWatchTools } from "./watch-tools";

const ORIGIN = "https://api.example.com";
const requested: string[] = [];

function stubFetch(response: Response | (() => Response)) {
  return vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    requested.push(url);
    return typeof response === "function" ? response() : response;
  });
}

function tool(reads?: SourceReadLedger) {
  const ctx = { userActorToken: "uat", apiOrigin: ORIGIN };
  const client = createApiClient(ctx);
  return (buildLocateTool({ ctx, client, reads }).locate as any).execute;
}

/** Answers the locate read with `body`, then runs the tool against `input`. */
function locate(
  input: { kind: string; id: string },
  body: unknown,
  status = 200,
  reads?: SourceReadLedger
) {
  const response =
    typeof body === "string"
      ? new Response(body, { status })
      : new Response(JSON.stringify(body), { status });
  vi.stubGlobal("fetch", stubFetch(response));
  return tool(reads)(input, {} as any) as Promise<any>;
}

const RUN = { kind: "run", id: "run_abc" };
const ERROR = { kind: "error", id: "error_abc" };
const UNAVAILABLE = { error: "Couldn't check error error_abc right now — try again." };

beforeEach(() => {
  requested.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("locate", () => {
  it("escapes both path segments", async () => {
    await locate({ kind: "run", id: "run_../../orgs" }, { found: false }, 404);

    expect(requested[0]).toBe(
      `${ORIGIN}/api/v1/locate/run/${encodeURIComponent("run_../../orgs")}`
    );
    expect(requested[0]).not.toContain("../");
  });

  it.each([
    ["run", "not-a-run-id"],
    ["deployment", "deployment"],
    ["deployment", "20260101.1"],
  ])("rejects a bad %s id shape without a fetch", async (kind, id) => {
    const result = await locate({ kind, id }, {});

    expect(result).toEqual({ error: expect.any(String) });
    expect(requested).toHaveLength(0);
  });

  it("returns a tool error on a transport failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      })
    );

    const result = await tool()(RUN, {} as any);

    expect(result).toEqual({ error: expect.stringContaining("Couldn't locate") });
  });

  it("attaches a next hint per scope when found", async () => {
    const result = await locate(ERROR, {
      found: true,
      kind: "error",
      id: "error_abc",
      scopes: [
        { projectRef: "proj_a", environmentName: "staging", environmentId: "env_a" },
        {
          projectRef: "proj_a",
          environmentName: "preview",
          environmentId: "env_b",
          branch: "feature-x",
        },
      ],
    });

    expect(result.found).toBe(true);
    expect(result.scopes).toHaveLength(2);
    expect(result.scopes[0].next).toBe(
      "call the relevant tool with project=proj_a environment=staging"
    );
    expect(result.scopes[1].next).toBe(
      "call the relevant tool with project=proj_a environment=preview branch=feature-x"
    );
  });

  it("points a deployment's next hint at get_deploy with its version", async () => {
    const result = await locate(
      { kind: "deployment", id: "deployment_abc" },
      {
        found: true,
        kind: "deployment",
        id: "deployment_abc",
        scopes: [
          {
            projectRef: "proj_a",
            environmentName: "prod",
            environmentId: "env_a",
            version: "20260101.1",
            shortCode: "abc1234",
          },
        ],
      }
    );

    expect(result.scopes[0].next).toBe(
      "call get_deploy version=20260101.1 with project=proj_a environment=prod"
    );
  });

  /**
   * A queue name is not unique across the organization: the same name is a different queue in
   * every project that uses it, so locate answers with every scope and the caller picks.
   */
  const QUEUE = { kind: "queue", id: "q-plain" };

  it("points a queue's next hint at get_queue with the name and kind it resolved", async () => {
    const result = await locate(QUEUE, {
      found: true,
      kind: "queue",
      id: "q-plain",
      scopes: [
        {
          projectRef: "proj_a",
          environmentName: "prod",
          environmentId: "env_a",
          queueName: "q-plain",
          queueType: "custom",
        },
      ],
    });

    expect(result.found).toBe(true);
    expect(result.scopes).toHaveLength(1);
    expect(result.scopes[0].next).toBe(
      "call get_queue queue=q-plain type=custom with project=proj_a environment=prod"
    );
  });

  it("returns every scope a queue name lives in, branch and all", async () => {
    const result = await locate(QUEUE, {
      found: true,
      kind: "queue",
      id: "q-plain",
      scopes: [
        {
          projectRef: "proj_a",
          environmentName: "prod",
          environmentId: "env_a",
          queueName: "q-plain",
          queueType: "task",
        },
        {
          projectRef: "proj_b",
          environmentName: "preview",
          environmentId: "env_b",
          branch: "feature-x",
          queueName: "q-plain",
          queueType: "custom",
        },
      ],
    });

    expect(result.scopes.map((scope: any) => scope.next)).toEqual([
      "call get_queue queue=q-plain type=task with project=proj_a environment=prod",
      "call get_queue queue=q-plain type=custom with project=proj_b environment=preview branch=feature-x",
    ]);
  });

  it("keeps a truncated queue result's truncated flag as data", async () => {
    const result = await locate(QUEUE, {
      found: true,
      kind: "queue",
      id: "q-plain",
      truncated: true,
      scopes: [
        {
          projectRef: "proj_a",
          environmentName: "prod",
          environmentId: "env_a",
          queueName: "q-plain",
          queueType: "custom",
        },
      ],
    });

    expect(result.truncated).toBe(true);
  });

  it("rejects an empty queue name without a fetch", async () => {
    const result = await locate({ kind: "queue", id: "   " }, {});

    expect(result).toEqual({ error: "A queue name can't be empty." });
    expect(requested).toHaveLength(0);
  });

  it("keeps a truncated not-found result's truncated flag as data too", async () => {
    const result = await locate(ERROR, { found: false, truncated: true }, 404);

    expect(result).toEqual({ found: false, truncated: true });
  });

  it("reports a warehouse failure (503) as unavailable, not as not found", async () => {
    const result = await locate(ERROR, { found: false, unavailable: true }, 503);

    expect(result).toEqual(UNAVAILABLE);
  });

  it("treats any 503 as unavailable even with an unparseable (proxy error page) body", async () => {
    const result = await locate(ERROR, "<html>503</html>", 503);

    expect(result).toEqual(UNAVAILABLE);
    expect(result).not.toHaveProperty("found");
  });

  it("records the found scope so schedule_watch refuses a run or error group silently landing elsewhere", async () => {
    const reads = createSourceReadLedger({ origin: ORIGIN, hasAuth: true, userActorToken: "uat" });
    const ctx = { projectRef: "P1", environmentName: "dev", environmentId: "env_p1_dev" };
    const watch = buildWatchTools({ ctx, reads }).schedule_watch as {
      execute: (input: unknown, opts: unknown) => Promise<any>;
    };

    await locate(
      RUN,
      {
        found: true,
        kind: "run",
        id: "run_abc",
        scopes: [{ projectRef: "P2", environmentName: "prod", environmentId: "env_p2_prod" }],
      },
      200,
      reads
    );
    const runResult = await watch.execute(
      {
        watch: {
          kind: "run_finished",
          runId: "run_abc",
          checkEveryMinutes: 1,
          maxHours: 2,
          note: "tell me when it finishes",
        },
      },
      {}
    );
    expect(runResult.error).toContain("Watches are limited to the current project/environment");
    expect(runResult.error).toContain("P2/prod");

    await locate(
      ERROR,
      {
        found: true,
        kind: "error",
        id: "error_abc",
        scopes: [{ projectRef: "P2", environmentName: "prod", environmentId: "env_p2_prod" }],
      },
      200,
      reads
    );
    const errorResult = await watch.execute(
      {
        watch: {
          kind: "error_recurrence",
          fingerprint: "error_abc",
          checkEveryMinutes: 5,
          maxHours: 1,
          note: "tell me if it recurs",
        },
      },
      {}
    );
    expect(errorResult.error).toContain("Watches are limited to the current project/environment");
    expect(errorResult.error).toContain("P2/prod");
  });

  it("passes through additive server fields it doesn't know about", async () => {
    const result = await locate(RUN, {
      found: true,
      kind: "run",
      id: "run_abc",
      scopes: [
        {
          projectRef: "proj_a",
          environmentName: "prod",
          environmentId: "env_a",
          futureField: "kept",
        },
      ],
    });

    expect(result.scopes[0].futureField).toBe("kept");
  });
});
