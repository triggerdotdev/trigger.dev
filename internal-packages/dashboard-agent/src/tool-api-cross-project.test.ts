import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodTypeAny } from "zod";
import { buildApiTools } from "./tool-api";
import { createApiClient } from "./tool-api-client";
import {
  getErrorSchema,
  getQueueSchema,
  getRunSchema,
  getRunTraceSchema,
  listRunsSchema,
} from "./tool-schemas";

/**
 * The `project`/`environment` override on data lookups: the JWT exchange has to target
 * the override, not ctx, and cache per target the same way the default path does. The
 * default path (no override) must be byte-for-byte unchanged.
 */

const ORIGIN = "https://api.example.com";

type Call = { url: string; body?: unknown };
let calls: Call[] = [];

function stubFetch() {
  return vi.fn(async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/jwt")) {
      // The env JWT is minted for whichever project/environment segment the exchange
      // addressed, so the token echoes it back for the assertions below.
      const match = url.match(/\/api\/v1\/projects\/([^/]+)\/([^/]+)\/jwt$/);
      return Response.json({ token: `jwt:${match![1]}/${match![2]}` });
    }
    return Response.json({ data: [] });
  });
}

function tools() {
  const ctx = {
    userActorToken: "uat",
    apiOrigin: ORIGIN,
    projectRef: "proj_current",
    environmentName: "prod",
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
});

describe("project/environment schema round-trip", () => {
  it.each([
    ["list_runs", listRunsSchema, {}],
    ["get_run", getRunSchema, { runId: "run_1" }],
    ["get_run_trace", getRunTraceSchema, { runId: "run_1" }],
    ["get_error", getErrorSchema, { errorId: "error_1" }],
    ["get_queue", getQueueSchema, { queue: "my-queue" }],
  ])("%s accepts project/environment and stays valid without them", (_name, schema, base) => {
    const inputSchema = schema.inputSchema as ZodTypeAny;
    const withOverride = inputSchema.safeParse({
      ...base,
      project: "proj_other",
      environment: "staging",
    });
    expect(withOverride.success).toBe(true);

    const withoutOverride = inputSchema.safeParse(base);
    expect(withoutOverride.success).toBe(true);
  });
});
