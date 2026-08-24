import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApiTools } from "./tool-api";
import { apiGet, createApiClient } from "./tool-api-client";

/**
 * A GET that never got an answer. The connection resets, or the body isn't JSON: either way the
 * tool has to say it couldn't read, because "couldn't read" and "isn't there" send the agent
 * down opposite paths — and a thrown fetch used to take the whole tool call out.
 */

const ORIGIN = "https://api.example.com";

const CTX = {
  userActorToken: "uat",
  apiOrigin: ORIGIN,
  projectRef: "proj_ref",
  environmentName: "prod",
};

function tools() {
  return buildApiTools({
    ctx: CTX,
    client: createApiClient(CTX),
    renderInvestigations: (() => []) as any,
  });
}

const run = (name: string, input: any = {}) =>
  (tools()[name] as any).execute(input, {} as any) as Promise<Record<string, any>>;

afterEach(() => vi.unstubAllGlobals());

describe("apiGet survives a request that never completes", () => {
  it("returns a transport failure instead of throwing when the connection breaks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );

    const result = await apiGet(ORIGIN, "/api/v1/projects", "uat");

    expect(result).toEqual({ ok: false, transport: "fetch failed" });
  });

  it("returns a transport failure when the body isn't the JSON it claims", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502</html>", { status: 200 }))
    );

    const result = await apiGet(ORIGIN, "/api/v1/projects", "uat");

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("transport");
  });
});

describe("a broken request reads as a broken request, never as an answer", () => {
  it("tells the model it couldn't list projects, rather than failing the tool call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("terminated");
      })
    );

    const result = await run("list_projects");

    expect(result.error).toBe("Couldn't list projects (the request failed: terminated).");
  });

  it("never reports a run as having no deployed version when the request broke", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("socket hang up");
      })
    );

    const result = await run("correlate_version", { runId: "run_1234" });

    // The 404 answer — "no commit to correlate" — is a claim about the run, not about the wire.
    expect(result.error).toBe(
      "Couldn't resolve the commit for run_1234 (the request failed: socket hang up)."
    );
    expect(JSON.stringify(result)).not.toContain("isn't locked to a deployed version");
  });

  it("classifies a busy query route as busy, not as a bad query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/jwt")
          ? Response.json({ token: "jwt" })
          : Response.json(
              { error: "We're experiencing a lot of queries at the moment." },
              { status: 429 }
            )
      )
    );

    const result = await createApiClient(CTX).postQuery("SELECT 1", undefined);

    expect(result).toMatchObject({ ok: false, kind: "busy" });
    expect((result as { error: string }).error).toContain("retry the same query shortly");
  });

  // The other half of the same invariant: only 429 is busy, so a rejected query still counts.
  it("classifies a rejected query as a query error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/jwt")
          ? Response.json({ token: "jwt" })
          : Response.json({ error: "Unknown expression identifier 'createdAt'." }, { status: 400 })
      )
    );

    const result = await createApiClient(CTX).postQuery("SELECT createdAt FROM runs", undefined);

    expect(result).toMatchObject({
      ok: false,
      kind: "query",
      error: "Unknown expression identifier 'createdAt'.",
    });
  });

  it("still reports a real 404 as the answer it is", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 }))
    );

    const result = await run("correlate_version", { runId: "run_1234" });

    expect(result.error).toContain("isn't locked to a deployed version");
  });
});
