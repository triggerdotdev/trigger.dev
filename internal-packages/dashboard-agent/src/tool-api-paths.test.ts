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
      return new Response(JSON.stringify({ token: "env-jwt" }), { status: 200 });
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
    spanLedger: { recordTraceSpans: () => {} },
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
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [
      "list_environments",
      { projectRef: TRAVERSING_ID },
      `/api/v1/projects/${ESCAPED_ID}/environments`,
    ],
    ["get_run", { runId: TRAVERSING_ID }, `/api/v3/runs/${ESCAPED_ID}`],
    ["get_run_trace", { runId: TRAVERSING_ID }, `/api/v1/runs/${ESCAPED_ID}/trace`],
    ["get_error", { errorId: TRAVERSING_ID }, `/api/v1/errors/${ESCAPED_ID}`],
  ])("%s escapes the id it is handed", async (name, input, expectedPath) => {
    await (tools()[name] as any).execute(input, {} as any);

    const call = requested.find((url) => !url.endsWith("/jwt"));
    expect(call).toBe(`${ORIGIN}${expectedPath}`);
    // Belt and braces: the raw traversal must not survive anywhere in the URL.
    expect(call).not.toContain("../");
  });
});
