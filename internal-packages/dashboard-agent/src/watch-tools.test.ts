import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodTypeAny } from "zod";
import { buildWatchTools } from "./watch-tools";
import { createApiClient } from "./tool-api-client";
import { scheduleWatchSchema } from "./tool-schemas";

/**
 * schedule_watch's `project`/`environment` override: the target environment id has to
 * come from the same JWT exchange every other env-scoped call uses (proving access),
 * never guessed — and the default (no override) path stays pure schema validation,
 * with no network call at all.
 */

const ORIGIN = "https://api.example.com";

// A minimal unsigned JWT whose payload carries `sub`, matching what the real exchange
// mints (see api.v1.projects.$projectRef.$env.jwt.ts): `claims = { sub: runtimeEnv.id }`.
function fakeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.`;
}

let calls: string[] = [];

function stubFetch() {
  return vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    const match = url.match(/\/api\/v1\/projects\/([^/]+)\/([^/]+)\/jwt$/);
    if (match) {
      return Response.json({ token: fakeJwt(`env_${match[1]}_${match[2]}`) });
    }
    return new Response("not found", { status: 404 });
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
  return buildWatchTools({ ctx, client: createApiClient(ctx) });
}

const WATCH = {
  kind: "backlog_drain" as const,
  queue: "my-queue",
  checkEveryMinutes: 15 as const,
  maxHours: 6,
  note: "checking on the backlog",
};

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", stubFetch());
});
afterEach(() => vi.unstubAllGlobals());

describe("schedule_watch project/environment override", () => {
  it("resolves the target environment id in a sibling project via the JWT exchange", async () => {
    const t = tools();

    const result = await (t.schedule_watch as any).execute(
      { watch: WATCH, project: "proj_other", environment: "staging" },
      {} as any
    );

    expect(result.error).toBeUndefined();
    expect(calls).toEqual([`${ORIGIN}/api/v1/projects/proj_other/staging/jwt`]);
    expect(result.intent).toEqual({
      kind: "watch",
      spec: WATCH,
      target: { projectRef: "proj_other", environmentId: "env_proj_other_staging" },
    });
  });

  it("defaults the target project to the current one when only environment is given", async () => {
    const t = tools();

    const result = await (t.schedule_watch as any).execute(
      { watch: WATCH, environment: "staging" },
      {} as any
    );

    expect(result.intent.target).toEqual({
      projectRef: "proj_current",
      environmentId: "env_proj_current_staging",
    });
  });

  it("makes no network call, and carries no target, on the default (no-override) path", async () => {
    const t = tools();

    const result = await (t.schedule_watch as any).execute({ watch: WATCH }, {} as any);

    expect(calls).toEqual([]);
    expect(result.intent.target).toBeUndefined();
  });

  it("errors, naming the target, when the exchange is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 403 }))
    );
    const t = tools();

    const result = await (t.schedule_watch as any).execute(
      { watch: WATCH, project: "proj_other", environment: "staging" },
      {} as any
    );

    expect(result.error).toBe("Couldn't reach that project/environment to watch it (status 403).");
  });
});

describe("scheduleWatchSchema round-trip", () => {
  it("accepts project/environment and stays valid without them", () => {
    const inputSchema = scheduleWatchSchema.inputSchema as ZodTypeAny;

    const withOverride = inputSchema.safeParse({
      watch: WATCH,
      project: "proj_other",
      environment: "staging",
    });
    expect(withOverride.success).toBe(true);

    const withoutOverride = inputSchema.safeParse({ watch: WATCH });
    expect(withoutOverride.success).toBe(true);
  });
});
