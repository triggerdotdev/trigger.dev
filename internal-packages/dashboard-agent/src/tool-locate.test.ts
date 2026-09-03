import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLocateTool } from "./tool-api";
import { createApiClient } from "./tool-api-client";

/**
 * The org-wide locator replaces the model-driven not-found sweep, so what it hands back
 * has to keep "not here" and "couldn't look" apart: only the route's own `found: false`
 * is an absence.
 */

const ORIGIN = "https://api.example.com";

let calls: Array<{ url: string; auth: string | null }> = [];

function stubFetch(reply: (url: string) => Response) {
  return vi.fn(async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, auth: new Headers(init.headers ?? {}).get("authorization") });
    return reply(url);
  });
}

function locate(overrides: Record<string, unknown> = {}) {
  const ctx = {
    userActorToken: "uat",
    apiOrigin: ORIGIN,
    projectRef: "proj_current",
    environmentName: "prod",
    ...overrides,
  };
  return buildLocateTool({ ctx, client: createApiClient(ctx) }).locate as any;
}

beforeEach(() => (calls = []));
afterEach(() => vi.unstubAllGlobals());

describe("locate", () => {
  it("asks the org-wide route with the delegated token and passes the scopes through", async () => {
    const found = {
      found: true,
      checked: "organization",
      scopes: [
        {
          projectRef: "proj_other",
          projectName: "Other",
          environmentName: "preview",
          environmentType: "PREVIEW",
          branchName: "feat/x",
          targetable: true,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      stubFetch(() => Response.json(found))
    );

    const result = await locate().execute({ kind: "run", id: "run_abc" }, {} as any);

    expect(calls).toEqual([{ url: `${ORIGIN}/api/v1/locate/run/run_abc`, auth: "Bearer uat" }]);
    expect(result).toEqual(found);
  });

  it("passes a not-found through verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(() => Response.json({ found: false, checked: "organization" }))
    );

    expect(await locate().execute({ kind: "error", id: "error_abc" }, {} as any)).toEqual({
      found: false,
      checked: "organization",
    });
    expect(calls[0].url).toBe(`${ORIGIN}/api/v1/locate/error/error_abc`);
  });

  it("reports a 401 or 403 as a failed lookup, never as an absence", async () => {
    for (const status of [401, 403]) {
      calls = [];
      vi.stubGlobal(
        "fetch",
        stubFetch(() => new Response("", { status }))
      );

      const result = await locate().execute({ kind: "run", id: "run_abc" }, {} as any);

      expect(result).toEqual({
        error: `Couldn't locate run run_abc (status ${status}). That is not evidence it doesn't exist.`,
      });
    }
  });

  it("says so when the turn has no delegated access", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(() => Response.json({}))
    );

    const result = await locate({ userActorToken: undefined }).execute(
      { kind: "run", id: "run_abc" },
      {} as any
    );

    expect(result).toEqual({ error: "No delegated access is available for this turn." });
    expect(calls).toEqual([]);
  });
});
