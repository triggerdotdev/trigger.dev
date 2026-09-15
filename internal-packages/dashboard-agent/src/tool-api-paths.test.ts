import { logger } from "@trigger.dev/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./tool-api-client";
import { buildApiTools } from "./tool-api";

/**
 * Every path segment a tool builds from a model-supplied id has to be escaped: the ids arrive as
 * bare strings, so an unescaped one lets the model steer the request at another route.
 */

const ORIGIN = "https://api.example.com";
const requested: string[] = [];

function stubFetch() {
  return vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    requested.push(url);
    if (url.endsWith("/jwt")) {
      return new Response(JSON.stringify({ token: "env-jwt", environmentId: "env_1" }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

function tools() {
  const ctx = {
    userActorToken: "uat",
    apiOrigin: ORIGIN,
    projectRef: "proj_ref",
    environmentName: "dev",
  };
  return buildApiTools({
    ctx,
    client: createApiClient(ctx),
    renderInvestigations: (() => []) as any,
  });
}

// The id a model could return to climb out of the segment it was given.
const TRAVERSING_ID = "../../orgs";
const ESCAPED_ID = encodeURIComponent(TRAVERSING_ID);

describe("model-supplied ids in tool request paths", () => {
  beforeEach(() => {
    requested.length = 0;
    vi.stubGlobal("fetch", stubFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // A project ref has a format, so a traversing one is refused rather than escaped.
  it("list_environments rejects a ref that isn't one, without asking", async () => {
    const result: any = await (tools().list_environments as any).execute(
      { projectRef: TRAVERSING_ID },
      {} as any
    );

    expect(result.error).toContain("isn't a project ref");
    expect(requested).toEqual([]);
  });

  it.each([
    ["get_run", { runId: TRAVERSING_ID }, `/api/v3/runs/${ESCAPED_ID}`],
    ["get_run_trace", { runId: TRAVERSING_ID }, `/api/v1/dashboard-agent/runs/${ESCAPED_ID}/trace`],
    ["get_error", { errorId: TRAVERSING_ID }, `/api/v1/errors/${ESCAPED_ID}`],
  ])("%s escapes the id it is handed", async (name, input, expectedPath) => {
    await (tools()[name] as any).execute(input, {} as any);

    const call = requested.find((url) => !url.endsWith("/jwt"));
    expect(call).toBe(`${ORIGIN}${expectedPath}`);
    // Belt and braces: the raw traversal must not survive anywhere in the URL.
    expect(call).not.toContain("../");
  });

  // The trace tool also reads the run row, for the timeline's queue wait and finish
  // time. `/api/v1/runs/:id` is not a route — it lands on the app's catch-all.
  it("get_run_trace reads the run itself from the v3 route", async () => {
    await (tools().get_run_trace as any).execute({ runId: "run_1" }, {} as any);

    const paths = requested.filter((url) => !url.endsWith("/jwt"));
    expect(paths).toEqual([
      `${ORIGIN}/api/v1/dashboard-agent/runs/run_1/trace`,
      `${ORIGIN}/api/v3/runs/run_1`,
    ]);
  });

  // Older self-hosted webapps don't have the agent trace route yet.
  it("get_run_trace falls back to the public trace route on a 404 from the agent route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        requested.push(url);
        if (url.endsWith("/jwt")) {
          return new Response(JSON.stringify({ token: "env-jwt", environmentId: "env_1" }), {
            status: 200,
          });
        }
        if (url.includes("/api/v1/dashboard-agent/runs/")) {
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await (tools().get_run_trace as any).execute({ runId: "run_1" }, {} as any);

    const paths = requested.filter((url) => !url.endsWith("/jwt"));
    expect(paths).toEqual([
      `${ORIGIN}/api/v1/dashboard-agent/runs/run_1/trace`,
      `${ORIGIN}/api/v3/runs/run_1`,
      `${ORIGIN}/api/v1/runs/run_1/trace`,
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // A second call falls back again, but the warning itself logs once per process.
    await (tools().get_run_trace as any).execute({ runId: "run_1" }, {} as any);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("get_run_trace does not fall back on a non-404 failure from the agent route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        requested.push(url);
        if (url.endsWith("/jwt")) {
          return new Response(JSON.stringify({ token: "env-jwt", environmentId: "env_1" }), {
            status: 200,
          });
        }
        if (url.includes("/api/v1/dashboard-agent/runs/")) {
          return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    await (tools().get_run_trace as any).execute({ runId: "run_1" }, {} as any);

    const paths = requested.filter((url) => !url.endsWith("/jwt"));
    expect(paths).toEqual([
      `${ORIGIN}/api/v1/dashboard-agent/runs/run_1/trace`,
      `${ORIGIN}/api/v3/runs/run_1`,
    ]);
  });
});
