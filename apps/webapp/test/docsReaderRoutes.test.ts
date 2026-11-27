import { beforeEach, describe, expect, it, vi } from "vitest";

const DOCS_ORIGIN = "https://trigger.dev";
const EVIL_ORIGIN = "https://evil.example";

const mocks = vi.hoisted(() => ({
  getUserId: vi.fn(),
  requireUserId: vi.fn(),
  limit: vi.fn(),
  getUserById: vi.fn(),
  authenticateSession: vi.fn(),
  projectFindFirst: vi.fn(),
  environmentFindFirst: vi.fn(),
  organizationFindMany: vi.fn(),
  createEnvironmentApiKey: vi.fn(),
  apiKeyAccessOptions: vi.fn(),
}));

vi.mock("~/env.server", () => ({
  env: {
    DOCS_ORIGINS: ["https://trigger.dev", "http://localhost:43600"],
    APP_ORIGIN: "https://cloud.trigger.dev",
    API_ORIGIN: "https://api.trigger.dev",
  },
}));
vi.mock("~/services/session.server", () => ({
  getUserId: mocks.getUserId,
  requireUserId: mocks.requireUserId,
}));
vi.mock("~/services/rateLimiter.server", () => ({
  createRedisRateLimitClient: vi.fn(),
  // Each limiter reports its key prefix, so tests can tell the reader limit from the create limit.
  RateLimiter: class {
    prefix: string;
    constructor(options: { keyPrefix: string }) {
      this.prefix = options.keyPrefix;
    }
    limit = (key: string) => mocks.limit(this.prefix, key);
  },
}));
vi.mock("~/models/user.server", () => ({ getUserById: mocks.getUserById }));
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateSession: mocks.authenticateSession,
    apiKeyAccessOptions: mocks.apiKeyAccessOptions,
  },
}));
vi.mock("~/models/api-key.server", () => ({
  createEnvironmentApiKey: mocks.createEnvironmentApiKey,
  isApiKeyUserError: () => false,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/db.server", () => ({
  prisma: {
    project: { findFirst: mocks.projectFindFirst },
    runtimeEnvironment: { findFirst: mocks.environmentFindFirst },
    organization: { findMany: mocks.organizationFindMany },
  },
  $replica: {},
}));

import { loader as meLoader } from "~/routes/resources.docs.me";
import * as devKeysRoute from "~/routes/resources.docs.projects.$projectRef.dev-keys";
import { loader as signinLoader } from "~/routes/resources.docs.signin";
import { SelectBestEnvironmentPresenter } from "~/presenters/SelectBestEnvironmentPresenter.server";
import type { UserFromSession } from "~/services/session.server";
import { docsHintCookie } from "~/services/docsReader.server";
import { env } from "~/env.server";

const USER = {
  id: "user_1",
  name: "Ada",
  displayName: null,
  avatarUrl: null,
  dashboardPreferences: { currentProjectId: "proj_id_2", projects: {} },
};

function request(path: string, init: { origin?: string; method?: string } = {}) {
  const headers = new Headers();
  if (init.origin) headers.set("Origin", init.origin);
  return new Request(`https://cloud.trigger.dev${path}`, { method: init.method, headers });
}

function callMe(origin?: string) {
  return meLoader({
    request: request("/resources/docs/me", { origin }),
    params: {},
    context: {},
  } as any);
}

function createKey(projectRef: string, origin: string | null = DOCS_ORIGIN, access?: string) {
  const req = request(`/resources/docs/projects/${projectRef}/dev-keys`, {
    origin: origin ?? undefined,
    method: "POST",
  });
  return devKeysRoute.action({
    request: access
      ? new Request(req, { body: new URLSearchParams({ access }), headers: req.headers })
      : req,
    params: { projectRef },
    context: {},
  } as any);
}

beforeEach(() => {
  mocks.getUserId.mockReset().mockResolvedValue("user_1");
  mocks.limit.mockReset().mockResolvedValue({ success: true, reset: Date.now() + 1000 });
  mocks.getUserById.mockReset().mockResolvedValue(USER);
  mocks.organizationFindMany.mockReset().mockResolvedValue([
    {
      slug: "acme",
      title: "Acme",
      projects: [
        {
          id: "proj_id_1",
          externalRef: "proj_one",
          slug: "one",
          name: "One",
          updatedAt: new Date(),
        },
        {
          id: "proj_id_2",
          externalRef: "proj_two",
          slug: "two",
          name: "Two",
          updatedAt: new Date(),
        },
      ],
    },
  ]);
  mocks.projectFindFirst
    .mockReset()
    .mockResolvedValue({ id: "proj_id_1", organizationId: "org_1", externalRef: "proj_one" });
  mocks.authenticateSession
    .mockReset()
    .mockResolvedValue({ ok: true, ability: { can: () => true } });
  mocks.environmentFindFirst.mockReset().mockResolvedValue({ id: "env_dev_1" });
  mocks.apiKeyAccessOptions.mockReset().mockResolvedValue({
    catalogue: {
      available: true,
      capabilities: [
        {
          id: "envvars",
          label: "Env vars",
          levels: [
            { id: "none", label: "None", scopes: [] },
            { id: "read", label: "Read", scopes: ["read:envvars"] },
            { id: "readWrite", label: "Read & write", scopes: ["read:envvars", "write:envvars"] },
          ],
        },
        {
          id: "runs",
          label: "Runs",
          levels: [
            { id: "none", label: "None", scopes: [] },
            { id: "read", label: "Read", scopes: ["read:runs"] },
            {
              id: "readWrite",
              label: "Read & write",
              scopes: ["read:runs", "write:runs"],
              requires: [{ capabilityId: "tasks", levelIds: ["read"], note: "" }],
            },
          ],
        },
        {
          id: "tasks",
          label: "Tasks",
          levels: [
            { id: "none", label: "None", scopes: [] },
            { id: "read", label: "Read", scopes: ["read:tasks"] },
          ],
        },
      ],
    },
    presets: [
      { id: "TRIGGER_ONLY", available: true, usesTaskSelection: true, scopes: ["trigger:tasks"] },
      {
        id: "ENVIRONMENT_OPERATOR",
        available: true,
        usesTaskSelection: false,
        scopes: ["trigger:tasks", "write:runs", "write:queues"],
      },
      {
        id: "DEPLOY_ONLY",
        available: true,
        usesTaskSelection: false,
        scopes: ["read:deployments", "write:deployments", "write:envvars", "read:envvars"],
      },
      { id: "FULL_ACCESS", available: true, usesTaskSelection: false, scopes: ["admin"] },
    ],
  });
  mocks.createEnvironmentApiKey.mockReset().mockResolvedValue({ plaintext: "tr_dev_sk_new" });
  mocks.requireUserId.mockReset().mockResolvedValue("user_1");
});

describe("GET /resources/docs/me", () => {
  // Catches: the docs reading the reader cross-origin without a session, or leaking it to other sites.
  it("refuses a request without a session", async () => {
    mocks.getUserId.mockResolvedValue(undefined);
    const response = await callMe(DOCS_ORIGIN);
    expect(response.status).toBe(401);
  });

  it("treats an ended session (redirect thrown by the session) as signed out", async () => {
    mocks.getUserId.mockRejectedValue(new Response(null, { status: 302 }));
    const response = await callMe(DOCS_ORIGIN);
    expect(response.status).toBe(401);
  });

  it("returns the reader with credentialed CORS for the docs origin", async () => {
    const response = await callMe(DOCS_ORIGIN);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(DOCS_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Vary")).toContain("Origin");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");

    const body = await response.json();
    expect(body.user).toEqual({ id: "user_1", name: "Ada", avatarUrl: null });
    expect(body.organizations[0].projects.map((p: { ref: string }) => p.ref)).toEqual([
      "proj_one",
      "proj_two",
    ]);
    // The same project the dashboard opens after login: the stored current project.
    expect(body.lastProjectRef).toBe("proj_two");
    expect(JSON.stringify(body)).not.toContain("tr_dev");
  });

  it("sends no CORS headers to any other origin", async () => {
    const response = await callMe(EVIL_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("answers a preflight only for the docs origin", async () => {
    const ok = await meLoader({
      request: request("/resources/docs/me", { origin: DOCS_ORIGIN, method: "OPTIONS" }),
      params: {},
      context: {},
    } as any);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(DOCS_ORIGIN);
    expect(ok.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST");

    const denied = await meLoader({
      request: request("/resources/docs/me", { origin: EVIL_ORIGIN, method: "OPTIONS" }),
      params: {},
      context: {},
    } as any);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(denied.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  it("rate limits per user", async () => {
    mocks.limit.mockResolvedValue({ success: false, reset: Date.now() + 30_000 });
    const response = await callMe(DOCS_ORIGIN);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(mocks.limit).toHaveBeenCalledWith("docs:reader", "user_1");
  });
});

describe("POST /resources/docs/projects/:projectRef/dev-keys", () => {
  it("creates a named dev key with the docs preset and returns it once", async () => {
    const response = await createKey("proj_one");
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(DOCS_ORIGIN);
    const body = await response.json();
    expect(body).toMatchObject({
      projectRef: "proj_one",
      apiKey: "tr_dev_sk_new",
      apiUrl: "https://api.trigger.dev",
      scopes: ["trigger:tasks", "write:runs", "write:queues"],
    });
    expect(body.name).toMatch(/^Docs \(\d{4}-\d{2}-\d{2}\)$/);

    expect(mocks.createEnvironmentApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.createEnvironmentApiKey.mock.calls[0][0]).toMatchObject({
      environmentId: "env_dev_1",
      taskEnvironmentId: "env_dev_1",
      userId: "user_1",
      name: body.name,
      presetId: "ENVIRONMENT_OPERATOR",
    });
    // Catches: docs keys piling up forever, one per browser tab session that needs one.
    const { expiresAt, description } = mocks.createEnvironmentApiKey.mock.calls[0][0];
    const days = (expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
    expect(description).toBe(
      `Created from the docs, expires ${expiresAt.toISOString().slice(0, 10)}`
    );
    // The reader's own dev environment, never another member's or a branch.
    expect(mocks.environmentFindFirst.mock.calls[0][0].where).toMatchObject({
      type: "DEVELOPMENT",
      parentEnvironmentId: null,
      orgMember: { userId: "user_1" },
    });
  });

  // Catches: a read-only operation the catalogue can't express (read:schedules) getting a
  // full-access key. The docs never create one; the reader goes to the API keys page.
  it.each([
    ["access only full access covers", "read:schedules", undefined],
    ["no preset catalogue (self-hosted)", undefined, null],
    ["no preset catalogue, scoped access", "read:envvars", null],
  ])("refuses to create a full-access key: %s", async (_label, access, options) => {
    if (options !== undefined) mocks.apiKeyAccessOptions.mockResolvedValue(options);
    const response = await createKey("proj_one", DOCS_ORIGIN, access);
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe(
      "This operation needs a key from the API keys page."
    );
    expect(mocks.createEnvironmentApiKey).not.toHaveBeenCalled();
  });

  // Catches: another site making a signed-in reader mint a key (CSRF).
  it.each([
    ["another origin", EVIL_ORIGIN],
    ["no Origin header", null],
  ])("refuses %s even with a valid session", async (_label, origin) => {
    const response = await createKey("proj_one", origin);
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(mocks.getUserId).not.toHaveBeenCalled();
    expect(mocks.createEnvironmentApiKey).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    mocks.getUserId.mockResolvedValue(undefined);
    const response = await createKey("proj_one");
    expect(response.status).toBe(401);
    expect(mocks.createEnvironmentApiKey).not.toHaveBeenCalled();
  });

  // Catches: a member who can't manage dev keys in the dashboard creating one through the docs.
  it("refuses a user without write:apiKeys on the dev environment", async () => {
    mocks.authenticateSession.mockResolvedValue({ ok: true, ability: { can: () => false } });
    const response = await createKey("proj_one");
    expect(response.status).toBe(403);
    expect(mocks.createEnvironmentApiKey).not.toHaveBeenCalled();
  });

  it("returns 404 for a project the user isn't a member of", async () => {
    mocks.projectFindFirst.mockResolvedValue(null);
    const response = await createKey("proj_other");
    expect(response.status).toBe(404);
    expect(mocks.projectFindFirst.mock.calls[0][0].where.organization).toMatchObject({
      members: { some: { userId: "user_1" } },
    });
  });

  it("rate limits key creation per user", async () => {
    mocks.limit.mockImplementation(async (prefix: string) => ({
      success: prefix !== "docs:create-key",
      reset: Date.now() + 60_000,
    }));
    const response = await createKey("proj_one");
    expect(response.status).toBe(429);
    // The docs read Retry-After to say when the reader can try again.
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe("Retry-After");
    expect(mocks.limit).toHaveBeenCalledWith("docs:create-key", "user_1");
    expect(mocks.createEnvironmentApiKey).not.toHaveBeenCalled();
  });

  it("creates a key with exactly the requested access from the capability catalogue", async () => {
    const response = await createKey("proj_one", DOCS_ORIGIN, "read:envvars");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.name).toMatch(/^Docs: env vars \(\d{4}-\d{2}-\d{2}\)$/);
    expect(body.access).toEqual(["read:envvars"]);
    expect(body.scopes).toEqual(["read:envvars"]);
    expect(mocks.createEnvironmentApiKey.mock.calls[0][0]).toMatchObject({
      presetId: "CUSTOM",
      capabilities: { envvars: "read" },
    });
  });

  it("adds the capabilities a level requires", async () => {
    const response = await createKey("proj_one", DOCS_ORIGIN, "write:runs");
    expect(response.status).toBe(200);
    expect(mocks.createEnvironmentApiKey.mock.calls[0][0].capabilities).toEqual({
      runs: "readWrite",
      tasks: "read",
    });
  });

  it("falls back to the smallest preset that covers access the catalogue can't express", async () => {
    const response = await createKey("proj_one", DOCS_ORIGIN, "write:deployments");
    expect(response.status).toBe(200);
    expect(mocks.createEnvironmentApiKey.mock.calls[0][0].presetId).toBe("DEPLOY_ONLY");
  });

  // Catches: the docs minting a key that can do more than the reader's role allows.
  it("refuses access above the reader's role", async () => {
    mocks.authenticateSession.mockResolvedValue({
      ok: true,
      ability: { can: (action: string, r: { type: string }) => r.type !== "envvars" },
    });
    const response = await createKey("proj_one", DOCS_ORIGIN, "write:envvars");
    expect(response.status).toBe(403);
    expect(mocks.createEnvironmentApiKey).not.toHaveBeenCalled();
  });

  // Catches: a Developer (no write:queues) unable to create the quick-start key, though the API
  // keys page lets them create the same preset. Only the requested scopes meet the role.
  it("lets a Developer create the default docs key, whose preset holds more than their role", async () => {
    const developer = {
      can: (action: string, r: { type: string }) =>
        !(action === "write" && ["queues", "deployments"].includes(r.type)),
    };
    mocks.authenticateSession.mockResolvedValue({ ok: true, ability: developer });
    const response = await createKey("proj_one");
    expect(response.status).toBe(200);
    expect(mocks.createEnvironmentApiKey.mock.calls[0][0].presetId).toBe("ENVIRONMENT_OPERATOR");

    // A scope they ask for by name still has to be one their role holds.
    mocks.createEnvironmentApiKey.mockClear();
    const scoped = await createKey("proj_one", DOCS_ORIGIN, "write:deployments");
    expect(scoped.status).toBe(403);
    expect((await scoped.json()).error).toBe("Your role can't grant write:deployments");
    expect(mocks.createEnvironmentApiKey).not.toHaveBeenCalled();
  });

  it.each(["read:envvars,DROP TABLE", "everything", "read:a,read:b,read:c,read:d,read:e,read:f"])(
    "rejects malformed access %s",
    async (access) => {
      const response = await createKey("proj_one", DOCS_ORIGIN, access);
      expect(response.status).toBe(400);
      expect(mocks.createEnvironmentApiKey).not.toHaveBeenCalled();
    }
  );

  it("refuses scoped access from another origin too", async () => {
    const response = await createKey("proj_one", EVIL_ORIGIN, "read:envvars");
    expect(response.status).toBe(403);
    expect(mocks.createEnvironmentApiKey).not.toHaveBeenCalled();
  });

  // Catches: a GET (or any read) handing out a key; root keys are never returned to the docs.
  it("has no way to read a key", async () => {
    const response = await devKeysRoute.loader({
      request: request("/resources/docs/projects/proj_one/dev-keys", { origin: DOCS_ORIGIN }),
      params: { projectRef: "proj_one" },
      context: {},
    } as any);
    expect(response.status).toBe(405);
    expect(mocks.environmentFindFirst).not.toHaveBeenCalled();
    // Root keys live on the environment's apiKey column; nothing here selects it.
    await createKey("proj_one");
    expect(mocks.environmentFindFirst.mock.calls[0][0].select).toEqual({ id: true });
  });
});

describe("GET /resources/docs/signin", () => {
  async function signin(to: string) {
    try {
      return await signinLoader({
        request: request(`/resources/docs/signin?to=${encodeURIComponent(to)}`),
        params: {},
        context: {},
      } as any);
    } catch (thrown) {
      return thrown as Response;
    }
  }

  it("returns to a docs page", async () => {
    const response = await signin("https://trigger.dev/docs/apikeys");
    expect(response.headers.get("Location")).toBe("https://trigger.dev/docs/apikeys");
  });

  // Catches: signing in from the docs goes straight back without a dashboard page, so the docs
  // would stay anonymous without the hint.
  it("sets the signed-in hint for the docs", async () => {
    const response = await signin("https://trigger.dev/docs/apikeys");
    expect(response.headers.get("Set-Cookie")).toMatch(/^docs_signed_in=1; .*Domain=trigger\.dev/);
  });

  // Catches: an open redirect through the docs sign-in link.
  it("never redirects to another origin", async () => {
    const response = await signin("https://evil.example/docs");
    expect(response.headers.get("Location")).toBe("https://trigger.dev/docs");
  });
});

describe("docsHintCookie", () => {
  const withCookie = (cookie?: string) =>
    new Request("https://cloud.trigger.dev/", { headers: cookie ? { Cookie: cookie } : {} });

  it("sets the hint for a signed-in reader, shared with the docs host", () => {
    expect(docsHintCookie(withCookie("__session=abc"), true)).toBe(
      "docs_signed_in=1; Path=/; Max-Age=31556952; SameSite=Lax; Domain=trigger.dev"
    );
  });

  it("leaves a matching hint alone", () => {
    expect(docsHintCookie(withCookie("a=b; docs_signed_in=1"), true)).toBeUndefined();
    expect(docsHintCookie(withCookie("__session=abc"), false)).toBeUndefined();
    expect(docsHintCookie(withCookie(), false)).toBeUndefined();
  });

  // Catches: a signed-out reader's docs still asking the dashboard who they are on every page.
  it("clears the hint once signed out", () => {
    expect(docsHintCookie(withCookie("docs_signed_in=1"), false)).toBe(
      "docs_signed_in=; Path=/; Max-Age=0; SameSite=Lax; Domain=trigger.dev"
    );
  });

  it("is host-only when the docs and the dashboard share a host", () => {
    const appOrigin = env.APP_ORIGIN;
    env.APP_ORIGIN = "http://localhost:3030";
    env.DOCS_ORIGINS.unshift("http://localhost:43000");
    try {
      expect(docsHintCookie(withCookie(), true)).not.toContain("Domain=");
    } finally {
      env.APP_ORIGIN = appOrigin;
      env.DOCS_ORIGINS.shift();
    }
  });

  // Catches: the hint scoped to the dashboard host when the parent docs host isn't listed first,
  // so docs signed in on that host never see it.
  it("shares the hint with a parent docs host listed after another origin", () => {
    env.DOCS_ORIGINS.unshift("https://preview.example.com");
    try {
      expect(docsHintCookie(withCookie(), true)).toContain("Domain=trigger.dev");
    } finally {
      env.DOCS_ORIGINS.shift();
    }
  });
});

describe("/_/ deeplinks with ?project=", () => {
  const user = USER as unknown as UserFromSession;

  it("opens the requested project when the user is a member", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "proj_id_1", organization: { id: "org_1" } });
    const presenter = new SelectBestEnvironmentPresenter({ project: { findFirst } } as never);

    const { project } = await presenter.getBestProject(user, "proj_one");

    expect(project.id).toBe("proj_id_1");
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      externalRef: "proj_one",
      organization: { members: { some: { userId: "user_1" } } },
    });
  });

  it("falls back to the most recent project for a ref the user can't reach", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const findMany = vi
      .fn()
      .mockResolvedValue([{ id: "proj_recent", organization: { id: "org_1" } }]);
    const presenter = new SelectBestEnvironmentPresenter({
      project: { findFirst, findMany },
    } as never);

    const { project } = await presenter.getBestProject(user, "proj_other");

    expect(project.id).toBe("proj_recent");
  });

  // Catches: a docs link's example payload carried into a different project than the one it named.
  it("says when the ref it was asked for wasn't the project it picked", async () => {
    const devEnvironment = {
      id: "env_dev",
      type: "DEVELOPMENT",
      slug: "dev",
      parentEnvironmentId: null,
      orgMember: { userId: "user_1" },
    };
    const recent = {
      id: "proj_recent",
      externalRef: "proj_recent_ref",
      organization: { id: "org_1" },
      environments: [devEnvironment],
    };
    const presenter = new SelectBestEnvironmentPresenter({
      project: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([recent]),
      },
    } as never);

    const asked = await presenter.call({ user, projectRef: "proj_other" });
    expect(asked.project.id).toBe("proj_recent");
    expect(asked.projectRefMatched).toBe(false);

    const unasked = await presenter.call({ user });
    expect(unasked.projectRefMatched).toBe(true);
  });
});
