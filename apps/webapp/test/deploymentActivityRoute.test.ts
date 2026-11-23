import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Preferences from "~/services/preferences/uiPreferences.server";
import type * as DeploymentActivity from "~/v3/deploymentActivity.server";

vi.setConfig({ testTimeout: 30_000 });

type Call = Record<string, unknown>;

const STATE = vi.hoisted(() => ({
  canRead: true,
  authorization: undefined as unknown,
  project: { id: "proj_1" } as { id: string } | null,
  environment: { id: "env_1" } as { id: string } | null,
  lookups: [] as unknown[][],
  activityCalls: [] as Call[],
  dayCalls: [] as Call[],
}));

vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-secret", NODE_ENV: "test" } }));
vi.mock("~/services/session.server", () => ({ requireUserId: async () => "user_1" }));
// The route builder authenticates the session and asks the role for `authorization`; this stands
// in for it with a role that either has that permission or doesn't.
vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardLoader:
    (
      options: { params: { parse: (params: unknown) => unknown }; authorization: unknown },
      handler: (args: unknown) => Promise<Response>
    ) =>
    async ({ request, params }: { request: Request; params: unknown }) => {
      STATE.authorization = options.authorization;
      if (!STATE.canRead) throw new Response(null, { status: 403 });
      return handler({ request, params: options.params.parse(params), user: { id: "user_1" } });
    },
}));
vi.mock("~/services/projectAuthScope.server", () => ({
  resolveProjectAuthScope: async () => ({}),
}));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {}, sqlDatabaseSchema: {} }));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async (...args: unknown[]) => {
    STATE.lookups.push(["project", ...args]);
    return STATE.project;
  },
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async (...args: unknown[]) => {
    STATE.lookups.push(["environment", ...args]);
    return STATE.environment;
  },
}));
vi.mock("~/v3/deploymentActivity.server", async (importOriginal) => ({
  ...(await importOriginal<typeof DeploymentActivity>()),
  deploymentActivityByDay: async (_prisma: unknown, _schema: unknown, options: Call) => {
    STATE.activityCalls.push(options);
    return { today: "2026-11-20", days: [{ day: "2026-11-19", total: 3, deployed: 2, failed: 1 }] };
  },
  deploymentsOnDay: async (_prisma: unknown, _schema: unknown, options: Call) => {
    STATE.dayCalls.push(options);
    return [];
  },
}));

type RouteArgs = { request: Request; params: Record<string, string>; context: object };

let loader: (args: RouteArgs) => Promise<Response>;
let action: (args: RouteArgs) => Promise<Response>;
let preferences: typeof Preferences;

beforeAll(async () => {
  const route =
    await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deployments.activity");
  loader = route.loader as unknown as typeof loader;
  action = route.action as unknown as typeof action;
  preferences = await import("~/services/preferences/uiPreferences.server");
}, 120_000);

beforeEach(() => {
  STATE.canRead = true;
  STATE.project = { id: "proj_1" };
  STATE.environment = { id: "env_1" };
  STATE.lookups = [];
  STATE.activityCalls = [];
  STATE.dayCalls = [];
});

const params = { organizationSlug: "acme", projectParam: "app", envParam: "prod" };
const url = "http://localhost/resources/orgs/acme/projects/app/env/prod/deployments/activity";

const load = (search = "", headers?: HeadersInit) =>
  loader({ request: new Request(`${url}${search}`, { headers }), params, context: {} });

/** The response a thrown `Response` carries, or the returned one. */
async function settled(promise: Promise<Response>): Promise<Response> {
  try {
    return await promise;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function cookieWithTimeZone(timeZone: string) {
  const session = await preferences.setTimezonePreference(timeZone, new Request(url));
  return (await preferences.uiPreferencesStorage.commitSession(session)).split(";")[0];
}

describe("deployment activity loader", () => {
  // Catches: deploy history served to a role that can't read deployments.
  it("needs read access to deployments", async () => {
    STATE.canRead = false;

    expect((await settled(load())).status).toBe(403);
    expect((await settled(load("?day=2026-11-19"))).status).toBe(403);
    expect(STATE.authorization).toEqual({ action: "read", resource: { type: "deployments" } });
    expect(STATE.lookups).toEqual([]);
  });

  // Catches: reading an environment's deploy history for someone who isn't in its project.
  it("is a 404 without a query when the user can't see the project", async () => {
    STATE.project = null;

    expect((await settled(load())).status).toBe(404);
    expect(STATE.lookups).toEqual([["project", "acme", "app", "user_1"]]);
    expect(STATE.activityCalls).toEqual([]);
  });

  it("is a 404 without a query when the user can't see the environment", async () => {
    STATE.environment = null;

    expect((await settled(load("?day=2026-11-19"))).status).toBe(404);
    expect(STATE.lookups).toEqual([
      ["project", "acme", "app", "user_1"],
      ["environment", "proj_1", "prod", "user_1"],
    ]);
    expect(STATE.activityCalls).toEqual([]);
    expect(STATE.dayCalls).toEqual([]);
  });

  // Catches: counts read for an environment id other than the one looked up for this user.
  it("returns the looked-up environment's days in the viewer's time zone", async () => {
    const response = await load("", { Cookie: await cookieWithTimeZone("Asia/Tokyo") });
    const body = await response.json();

    expect(STATE.activityCalls).toEqual([{ environmentId: "env_1", timeZone: "Asia/Tokyo" }]);
    expect(body).toEqual({
      timeZone: "Asia/Tokyo",
      today: "2026-11-20",
      days: [{ day: "2026-11-19", total: 3, deployed: 2, failed: 1 }],
    });
  });

  it("uses UTC when no time zone is saved", async () => {
    const body = await (await load()).json();

    expect(body.timeZone).toBe("UTC");
    expect(STATE.activityCalls).toEqual([{ environmentId: "env_1", timeZone: "UTC" }]);
  });

  it("returns one day's deploys for ?day=", async () => {
    const body = await (await load("?day=2026-11-19")).json();

    expect(body).toEqual({ day: "2026-11-19", deployments: [] });
    expect(STATE.dayCalls).toEqual([
      { environmentId: "env_1", day: "2026-11-19", timeZone: "UTC" },
    ]);
    expect(STATE.activityCalls).toEqual([]);
  });

  // Catches: a day that isn't a date reaching the query.
  it.each(["2026-02-31", "0000-01-01", "yesterday", ""])("is a 400 for ?day=%s", async (day) => {
    expect((await settled(load(`?day=${day}`))).status).toBe(400);
    expect(STATE.dayCalls).toEqual([]);
    expect(STATE.activityCalls).toEqual([]);
  });
});

describe("deployment activity preference", () => {
  const save = (show: string, cookie?: string) =>
    action({
      request: new Request(url, {
        method: "POST",
        body: new URLSearchParams({ show }),
        headers: cookie ? { Cookie: cookie } : undefined,
      }),
      params,
      context: {},
    });

  const cookieFrom = (response: Response) => response.headers.get("Set-Cookie")?.split(";")[0];
  const read = (cookie?: string) =>
    preferences.getDeployActivityPreference(
      new Request(url, { headers: cookie ? { Cookie: cookie } : undefined })
    );

  // Catches: the grid (and its query) on for people who never asked for it.
  it("is off until it's switched on", async () => {
    expect(await read()).toBe(false);
  });

  it("remembers on and off", async () => {
    const on = cookieFrom(await save("true"));
    expect(on).toBeDefined();
    expect(await read(on)).toBe(true);

    const off = cookieFrom(await save("false", on));
    expect(await read(off)).toBe(false);
  });

  // Catches: saving the switch dropping the other preferences kept in the same cookie.
  it("keeps the other preferences in the cookie", async () => {
    const saved = cookieFrom(await save("true", await cookieWithTimeZone("Europe/London")));

    expect(
      await preferences.getTimezonePreference(new Request(url, { headers: { Cookie: saved! } }))
    ).toBe("Europe/London");
  });

  it("rejects anything but true or false", async () => {
    const response = await save("maybe");

    expect(response.status).toBe(400);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });
});
