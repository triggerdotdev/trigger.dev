import { createStandalonePostgresContainer } from "@internal/testcontainers";
import type { AuditLogContext, AuditLogInput } from "@trigger.dev/plugins";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Database from "~/db.server";
import type * as AuditLogs from "~/services/auditLogs/auditLogs.server";
import type * as HttpAsyncStorage from "~/services/httpAsyncStorage.server";
import type * as SessionStorage from "~/services/sessionStorage.server";
import type * as Repository from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  createEnvironmentVariable,
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";
import {
  enableAuditRecording,
  installAuditLogPlugin,
  uninstallAuditLogPlugin,
} from "./helpers/auditLogPlugin";

// Env var reads through the real routes, auth and presenters, against a real database: each read
// records the right action and target, never a value, and only for values the response sent.

vi.setConfig({ testTimeout: 60_000 });

const SESSION_SECRET = "test-session-secret-for-env-var-read-audit";
const PLAIN_VALUE = "postgres://plain-value-host";
/** Prod's value differs, so Compare lists the key: by default it leaves out keys that match. */
const PROD_PLAIN_VALUE = "postgres://prod-plain-value-host";
const SECRET_VALUE = "sk_live_secret_value_123";

let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let database: typeof Database;
let auditLogs: typeof AuditLogs;
let httpAsyncStorage: typeof HttpAsyncStorage;
let sessionStorage: typeof SessionStorage;
let repositoryModule: typeof Repository;
let disableRecording: (() => Promise<void>) | undefined;

beforeAll(async () => {
  container = await createStandalonePostgresContainer();
  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("SESSION_SECRET", SESSION_SECRET);
  vi.stubEnv("AUDIT_LOGS_RECORDING_ENABLED", "true");

  database = await import("~/db.server");
  auditLogs = await import("~/services/auditLogs/auditLogs.server");
  httpAsyncStorage = await import("~/services/httpAsyncStorage.server");
  sessionStorage = await import("~/services/sessionStorage.server");
  repositoryModule =
    await import("~/v3/environmentVariables/environmentVariablesRepository.server");
  // Recording needs the global `auditLogsRecording` flag too, in the container's database.
  disableRecording = await enableAuditRecording();
}, 120_000);

afterAll(async () => {
  await disableRecording?.();
  uninstallAuditLogPlugin();
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  vi.unstubAllEnvs();
});

let recorded: Array<{ input: AuditLogInput; context: AuditLogContext }>;

beforeEach(() => {
  // A fresh API read rollup per test, as in a freshly started process.
  delete (globalThis as any).__trigger_singletons?.auditEnvVarReadRollup;
  recorded = installAuditLogPlugin().recorded;
});

async function events() {
  await auditLogs.auditLogs.flush();
  return recorded.map(({ input, context }) => ({ input, context }));
}

function expectNoValues(value: unknown) {
  const json = JSON.stringify(value);
  expect(json).not.toContain(PLAIN_VALUE);
  expect(json).not.toContain(PROD_PLAIN_VALUE);
  expect(json).not.toContain(SECRET_VALUE);
}

/** An org with Dev and Prod, a plain and a secret variable in each, and its member's login. */
async function setup() {
  const prisma = database.prisma;
  const { user, organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
  const dev = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "DEVELOPMENT",
    orgMemberId: orgMember.id,
    slug: "dev",
  });
  const prod = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: "prod",
  });
  const repository = new repositoryModule.EnvironmentVariablesRepository(prisma, database.$replica);
  for (const environment of [dev, prod]) {
    await createEnvironmentVariable(repository, project.id, {
      environmentId: environment.id,
      key: "DATABASE_URL",
      value: environment === dev ? PLAIN_VALUE : PROD_PLAIN_VALUE,
      userId: user.id,
    });
    await createEnvironmentVariable(repository, project.id, {
      environmentId: environment.id,
      key: "API_SECRET",
      value: SECRET_VALUE,
      isSecret: true,
      userId: user.id,
    });
  }
  // Creating the variables records envvar.created; each test looks only at the reads that follow.
  await auditLogs.auditLogs.flush();
  recorded.length = 0;
  const auth = await sessionStorage.getSession();
  auth.set("user", { userId: user.id });
  const cookie = (await sessionStorage.commitSession(auth)).split(";")[0]!;
  return { user, organization, project, dev, prod, cookie };
}

/** Runs a loader the way server.ts runs a request, so the auth functions note the identity. */
function inRequest<T>(path: string, fn: () => Promise<T>) {
  return httpAsyncStorage.runWithHttpContext(
    {
      requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
      path,
      host: "localhost",
      method: "GET",
      abortController: new AbortController(),
    },
    fn
  );
}

describe("API routes", () => {
  async function load(
    route: Promise<{ loader: (args: any) => Promise<Response> }>,
    url: string,
    params: Record<string, string>,
    apiKey: string
  ): Promise<Response> {
    const { loader } = await route;
    return inRequest(new URL(url).pathname, () =>
      loader({
        request: new Request(url, { headers: { Authorization: `Bearer ${apiKey}` } }),
        params,
        context: {},
      })
    );
  }

  // Catches: the dev CLI / `trigger env` listing not recorded, or recorded with values.
  it("GET /api/v1/projects/:ref/envvars records envvar.listed for the key's environment", async () => {
    const { organization, project, dev } = await setup();
    const response = await load(
      import("~/routes/api.v1.projects.$projectRef.envvars") as any,
      `http://localhost/api/v1/projects/${project.externalRef}/envvars`,
      { projectRef: project.externalRef },
      dev.apiKey
    );
    expect(response.status).toBe(200);

    const recordedEvents = await events();
    expect(recordedEvents.map((event) => event.input)).toEqual([
      expect.objectContaining({
        category: "envvars",
        action: "envvar.listed",
        organizationId: organization.id,
        projectId: project.id,
        environmentId: dev.id,
        environmentType: "DEVELOPMENT",
        target: { type: "environment", id: dev.id, name: "dev" },
      }),
    ]);
    expect(recordedEvents[0]!.context.actor).toEqual({ type: "api_key", id: dev.id });
    expectNoValues(recordedEvents);
  });

  // Catches: the SDK `envvars.list` endpoint not recorded as a listing.
  it("GET /api/v1/projects/:ref/envvars/:slug records envvar.listed", async () => {
    const { project, dev } = await setup();
    const response = await load(
      import("~/routes/api.v1.projects.$projectRef.envvars.$slug") as any,
      `http://localhost/api/v1/projects/${project.externalRef}/envvars/dev`,
      { projectRef: project.externalRef, slug: "dev" },
      dev.apiKey
    );
    expect(response.status).toBe(200);
    const recordedEvents = await events();
    expect(recordedEvents.map((event) => [event.input.action, event.input.target])).toEqual([
      ["envvar.listed", { type: "environment", id: dev.id, name: "dev" }],
    ]);
    expectNoValues(recordedEvents);
  });

  // Catches: a single-key read recorded as a listing, without the key, or with its value.
  it("GET /api/v1/projects/:ref/envvars/:slug/:name records envvar.read for that key", async () => {
    const { project, dev } = await setup();
    const variable = await database.prisma.environmentVariable.findFirstOrThrow({
      where: { projectId: project.id, key: "DATABASE_URL" },
    });
    const response = await load(
      import("~/routes/api.v1.projects.$projectRef.envvars.$slug.$name") as any,
      `http://localhost/api/v1/projects/${project.externalRef}/envvars/dev/DATABASE_URL`,
      { projectRef: project.externalRef, slug: "dev", name: "DATABASE_URL" },
      dev.apiKey
    );
    expect(response.status).toBe(200);
    const recordedEvents = await events();
    expect(recordedEvents.map((event) => event.input)).toEqual([
      expect.objectContaining({
        action: "envvar.read",
        environmentId: dev.id,
        target: { type: "environment_variable", id: variable.id, name: "DATABASE_URL" },
      }),
    ]);
    expectNoValues(recordedEvents);
  });

  // Catches: a read recorded when nothing was returned.
  it("records nothing when the key isn't found", async () => {
    const { project, dev } = await setup();
    const response = await load(
      import("~/routes/api.v1.projects.$projectRef.envvars.$slug.$name") as any,
      `http://localhost/api/v1/projects/${project.externalRef}/envvars/dev/MISSING`,
      { projectRef: project.externalRef, slug: "dev", name: "MISSING" },
      dev.apiKey
    );
    expect(response.status).toBe(404);
    expect(await events()).toEqual([]);
  });

  // Catches: repeated CLI reads (every `trigger dev` rebuild) recorded one by one.
  it("rolls repeated reads by the same key up into one event", async () => {
    const { project, dev } = await setup();
    for (let i = 0; i < 3; i++) {
      const response = await load(
        import("~/routes/api.v1.projects.$projectRef.envvars") as any,
        `http://localhost/api/v1/projects/${project.externalRef}/envvars`,
        { projectRef: project.externalRef },
        dev.apiKey
      );
      expect(response.status).toBe(200);
    }
    expect((await events()).map((event) => event.input.action)).toEqual(["envvar.listed"]);
  });
});

describe("dashboard", () => {
  const envVarsPath = (organizationSlug: string, projectSlug: string) =>
    `/orgs/${organizationSlug}/projects/${projectSlug}/env/dev/environment-variables`;

  async function load(
    route: Promise<{ loader: (args: any) => Promise<Response> }>,
    url: string,
    params: Record<string, string>,
    cookie: string
  ): Promise<Response> {
    const { loader } = await route;
    return inRequest(new URL(url).pathname, () =>
      loader({
        request: new Request(url, { headers: { Cookie: cookie } }),
        params,
        context: {},
      })
    );
  }

  // Catches: a page load not recorded, recorded per variable, or carrying values.
  it("records one envvar.listed per environment the list page sent", async () => {
    const { organization, project, dev, prod, cookie } = await setup();
    const response = await load(
      import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route") as any,
      // Every environment: by default the list shows only the one in the URL.
      `http://localhost${envVarsPath(organization.slug, project.slug)}?env=all`,
      { organizationSlug: organization.slug, projectParam: project.slug, envParam: "dev" },
      cookie
    );
    expect(response.status).toBe(200);
    const recordedEvents = await events();
    expect(
      recordedEvents.map((event) => [event.input.action, event.input.environmentId]).sort()
    ).toEqual(
      [
        ["envvar.listed", dev.id],
        ["envvar.listed", prod.id],
      ].sort()
    );
    expect(recordedEvents[0]!.context).toMatchObject({ source: "dashboard" });
    expectNoValues(recordedEvents);
  });

  // Catches: the key panel not recording a read, or not for a secret, whose key it shows without its
  // value (as the list records a secret-only environment).
  it("records envvar.read per environment the key panel shows, secrets included", async () => {
    const { organization, project, dev, prod, cookie } = await setup();
    const keyPanel = (key: string) =>
      load(
        import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.key.$keyParam/route") as any,
        `http://localhost${envVarsPath(organization.slug, project.slug)}/key/${key}`,
        {
          organizationSlug: organization.slug,
          projectParam: project.slug,
          envParam: "dev",
          keyParam: key,
        },
        cookie
      );

    const plain = await keyPanel("DATABASE_URL");
    expect(plain.status).toBe(200);
    expect(
      (await events()).map((event) => [event.input.action, event.input.environmentId]).sort()
    ).toEqual(
      [
        ["envvar.read", dev.id],
        ["envvar.read", prod.id],
      ].sort()
    );

    recorded.length = 0;
    const secret = await keyPanel("API_SECRET");
    expect(secret.status).toBe(200);
    expect(await secret.text()).not.toContain(SECRET_VALUE);
    const secretReads = await events();
    expect(
      secretReads.map((event) => [event.input.action, event.input.environmentId]).sort()
    ).toEqual(
      [
        ["envvar.read", dev.id],
        ["envvar.read", prod.id],
      ].sort()
    );
    expectNoValues(secretReads);
  });

  // Catches: Compare sending both environments' values with no read recorded, when loaded
  // directly rather than through the list.
  it("records envvar.listed for both sides when Compare is loaded directly", async () => {
    const { organization, project, dev, prod, cookie } = await setup();
    const response = await load(
      import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables_.compare/route") as any,
      `http://localhost${envVarsPath(organization.slug, project.slug)}/compare?left=dev&right=prod`,
      { organizationSlug: organization.slug, projectParam: project.slug, envParam: "dev" },
      cookie
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(PLAIN_VALUE);
    expect(body).toContain(PROD_PLAIN_VALUE);
    const recordedEvents = await events();
    expect(
      recordedEvents.map((event) => [event.input.action, event.input.environmentId]).sort()
    ).toEqual(
      [
        ["envvar.listed", dev.id],
        ["envvar.listed", prod.id],
      ].sort()
    );
    expectNoValues(recordedEvents);
  });

  // Catches: Needs attention sending the environment's values with no read recorded, when loaded
  // directly. Values set in the last day are listed there as changed recently.
  it("records envvar.listed for the target when Needs attention is loaded directly", async () => {
    const { organization, project, dev, cookie } = await setup();
    const response = await load(
      import("~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables_.attention/route") as any,
      `http://localhost${envVarsPath(organization.slug, project.slug)}/attention`,
      { organizationSlug: organization.slug, projectParam: project.slug, envParam: "dev" },
      cookie
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(PLAIN_VALUE);
    const recordedEvents = await events();
    expect(recordedEvents.map((event) => [event.input.action, event.input.environmentId])).toEqual([
      ["envvar.listed", dev.id],
    ]);
    expectNoValues(recordedEvents);
  });
});
