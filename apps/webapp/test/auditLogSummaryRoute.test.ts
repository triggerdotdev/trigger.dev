import { createStandalonePostgresContainer } from "@internal/testcontainers";
import type {
  AuditLogEventQuery,
  AuditLogEventSummary,
  AuditLogEventSummaryQuery,
} from "@trigger.dev/plugins";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditLogSummaryRangeSearch,
  auditLogSummarySearch,
} from "~/components/auditLogs/auditLogSummarySearch";
import type * as Database from "~/db.server";
import type * as HttpAsyncStorage from "~/services/httpAsyncStorage.server";
import type { rbac as Rbac } from "~/services/rbac.server";
import type * as SessionStorage from "~/services/sessionStorage.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";
import { installAuditLogPlugin, uninstallAuditLogPlugin } from "./helpers/auditLogPlugin";

// The key summary's route, which the audit log page loads after it renders, through the real
// routes, session and access rules against a real database: open only where the page is, and
// summing up the events the page lists for the same URL. The audit plugin is the in-memory one: the
// real plugin isn't part of this repo.

vi.setConfig({ testTimeout: 60_000 });

// The webapp's RBAC is the OSS fallback here, which has no roles: every member may do everything.
// Only the ability is replaced, standing in for the enterprise plugin's roles, for the users a test
// takes `manage:audit-logs` away from. Session and membership checks stay the real ones.
const roles = vi.hoisted(() => ({ withoutAuditLogs: new Set<string>() }));

vi.mock("~/services/rbac.server", async (importOriginal) => {
  const { rbac } = await importOriginal<{ rbac: typeof Rbac }>();
  return {
    rbac: {
      ...rbac,
      authenticateSession: async (
        request: Request,
        context: Parameters<typeof rbac.authenticateSession>[1]
      ) => {
        const result = await rbac.authenticateSession(request, context);
        if (!result.ok || !context.userId || !roles.withoutAuditLogs.has(context.userId)) {
          return result;
        }
        const { ability } = result;
        return {
          ...result,
          ability: {
            can: (action: string, resource: Parameters<typeof ability.can>[1]) =>
              !(action === "manage" && [resource].flat().some((r) => r.type === "audit-logs")) &&
              ability.can(action, resource),
            canSuper: () => ability.canSuper(),
          },
        };
      },
    },
  };
});

const SESSION_SECRET = "test-session-secret-for-audit-log-summary";

let container: Awaited<ReturnType<typeof createStandalonePostgresContainer>>;
let database: typeof Database;
let httpAsyncStorage: typeof HttpAsyncStorage;
let sessionStorage: typeof SessionStorage;

beforeAll(async () => {
  container = await createStandalonePostgresContainer();
  vi.stubEnv("DATABASE_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_URL", container.url);
  vi.stubEnv("DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("CONTROL_PLANE_DATABASE_READ_REPLICA_URL", container.url);
  vi.stubEnv("SESSION_SECRET", SESSION_SECRET);

  database = await import("~/db.server");
  httpAsyncStorage = await import("~/services/httpAsyncStorage.server");
  sessionStorage = await import("~/services/sessionStorage.server");
}, 120_000);

afterAll(async () => {
  uninstallAuditLogPlugin();
  await database?.$replica.$disconnect();
  await database?.prisma.$disconnect();
  await container?.container.stop();
  vi.unstubAllEnvs();
});

let listed: AuditLogEventQuery[];
let summarized: AuditLogEventSummaryQuery[];
/** What the plugin answers a summary with. */
let summaryAnswer: AuditLogEventSummary | null;

beforeEach(() => {
  listed = [];
  summarized = [];
  summaryAnswer = null;
  installAuditLogPlugin({
    listEvents: async (query) => {
      listed.push(query);
      return { events: [], nextCursor: null };
    },
    summarizeEvents: async (query) => {
      summarized.push(query);
      return summaryAnswer;
    },
  });
});

/** A member's login, and their org, with audit log access unless `withAccess` is false. */
async function setup({ withAccess = true }: { withAccess?: boolean } = {}) {
  const prisma = database.prisma;
  const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
  if (withAccess) {
    await prisma.organization.update({
      where: { id: organization.id },
      data: { featureFlags: { [FEATURE_FLAG.hasAuditLogsAccess]: true } },
    });
  }
  return { user, organization, project, cookie: await login(user.id) };
}

async function login(userId: string) {
  const auth = await sessionStorage.getSession();
  auth.set("user", { userId });
  return (await sessionStorage.commitSession(auth)).split(";")[0]!;
}

type Loader = (args: any) => Promise<Response>;
const summaryRoute = () =>
  import("~/routes/resources.orgs.$organizationSlug.audit-log.summary") as Promise<{
    loader: Loader;
  }>;
const filterOptionsRoute = () =>
  import("~/routes/resources.orgs.$organizationSlug.audit-log.filter-options") as Promise<{
    loader: Loader;
  }>;
const pageRoute = () =>
  import("~/routes/_app.orgs.$organizationSlug.settings.audit-log/route") as Promise<{
    loader: Loader;
  }>;

/** Runs a loader the way server.ts runs a request. A thrown response is returned. */
async function load(
  route: Promise<{ loader: Loader }>,
  url: string,
  organizationSlug: string,
  cookie?: string
) {
  const { loader } = await route;
  return httpAsyncStorage.runWithHttpContext(
    {
      requestId: `req_${Math.random().toString(36).slice(2, 8)}`,
      path: new URL(url).pathname,
      host: "localhost",
      method: "GET",
      abortController: new AbortController(),
    },
    async () => {
      try {
        return await loader({
          request: new Request(url, { headers: cookie ? { Cookie: cookie } : {} }),
          params: { organizationSlug },
          context: {},
        });
      } catch (thrown) {
        if (thrown instanceof Response) return thrown;
        throw thrown;
      }
    }
  );
}

/** A typedjson body. */
async function body<T>(response: Response): Promise<T> {
  const json = (await response.json()) as { json?: T } & T;
  return json.json ?? json;
}

const summaryUrl = (slug: string, search: string) =>
  `http://localhost/resources/orgs/${slug}/audit-log/summary?${search}`;
const filterOptionsUrl = (slug: string) =>
  `http://localhost/resources/orgs/${slug}/audit-log/filter-options?menu=actor`;
const pageUrl = (slug: string, search: string) =>
  `http://localhost/orgs/${slug}/settings/audit-log?${search}`;

describe("audit log summary route", () => {
  // Catches: the summary answering for another org than the member's, or not at all.
  it("sums up a member's own org", async () => {
    const { organization, cookie } = await setup();

    const response = await load(
      summaryRoute(),
      summaryUrl(organization.slug, "credential=key:k1"),
      organization.slug,
      cookie
    );

    expect(response.status).toBe(200);
    expect(summarized.map((query) => query.organizationId)).toEqual([organization.id]);
  });

  // Catches: the summary open where the page isn't: an org without audit log access, an org the
  // user isn't a member of, or no login. The filter options route answers the same.
  it("is closed wherever the page is", async () => {
    const { organization: withoutAccess, cookie } = await setup({ withAccess: false });
    const { organization: otherOrg } = await setup();

    for (const slug of [withoutAccess.slug, otherOrg.slug]) {
      const summary = await load(
        summaryRoute(),
        summaryUrl(slug, "credential=key:k1"),
        slug,
        cookie
      );
      const options = await load(filterOptionsRoute(), filterOptionsUrl(slug), slug, cookie);
      expect([summary.status, options.status]).toEqual([404, 404]);
    }
    const signedOut = await load(
      summaryRoute(),
      summaryUrl(otherOrg.slug, "credential=key:k1"),
      otherOrg.slug
    );
    expect(signedOut.status).toBe(302);
    expect(summarized).toEqual([]);
  });

  // Catches: the summary open to a role that can't view the audit log, e.g. a Developer.
  it("refuses a member without manage:audit-logs", async () => {
    const { user, organization, cookie } = await setup();
    roles.withoutAuditLogs.add(user.id);
    try {
      const slug = organization.slug;
      const summary = await load(
        summaryRoute(),
        summaryUrl(slug, "credential=key:k1"),
        slug,
        cookie
      );
      const options = await load(filterOptionsRoute(), filterOptionsUrl(slug), slug, cookie);
      expect([summary.status, options.status]).toEqual([403, 403]);
      expect(summarized).toEqual([]);
    } finally {
      roles.withoutAuditLogs.delete(user.id);
    }
  });

  // Catches: a key's last use or end shown wrongly, for another org's key, or for a personal token,
  // whose use would tell the org about its owner's use elsewhere.
  it("says when an org's own key was last used and how it ended, never a personal token's", async () => {
    const prisma = database.prisma;
    const { organization, project, cookie } = await setup();
    const { organization: otherOrg, project: otherProject } = await setup();
    const slug = organization.slug;
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
      slug: "prod",
    });
    const otherEnvironment = await createRuntimeEnvironment(prisma, {
      projectId: otherProject.id,
      organizationId: otherOrg.id,
      type: "PRODUCTION",
      slug: "prod",
    });
    const rotatedAt = new Date("2026-11-19T14:00:00.000Z");
    const graceUntil = new Date("2026-11-20T14:00:00.000Z");
    await prisma.revokedApiKey.create({
      data: {
        apiKey: "tr_prod_rotated_k9Qz",
        runtimeEnvironmentId: environment.id,
        createdAt: rotatedAt,
        expiresAt: graceUntil,
      },
    });
    const lastUsedAt = new Date("2026-11-19T13:58:00.000Z");
    const key = (environmentId: string, revokedAt: Date | null) =>
      prisma.apiKey.create({
        data: {
          name: "ci",
          keyHash: `hash_${Math.random().toString(36).slice(2)}`,
          lastFour: "ab12",
          runtimeEnvironmentId: environmentId,
          revokedAt,
          lastUsedAt,
        },
      });
    const revokedKey = await key(environment.id, rotatedAt);
    const otherOrgKey = await key(otherEnvironment.id, rotatedAt);
    const liveKey = await key(environment.id, null);
    const expiredThenRevoked = await prisma.apiKey.create({
      data: {
        name: "old",
        keyHash: `hash_${Math.random().toString(36).slice(2)}`,
        lastFour: "cd34",
        runtimeEnvironmentId: environment.id,
        expiresAt: new Date("2026-11-02T00:00:00.000Z"),
        revokedAt: rotatedAt,
      },
    });
    const expiredToken = await prisma.organizationAccessToken.create({
      data: {
        name: "deploy-bot",
        hashedToken: `hash_${Math.random().toString(36).slice(2)}`,
        organizationId: organization.id,
        expiresAt: new Date("2026-11-02T00:00:00.000Z"),
      },
    });

    summaryAnswer = {
      eventCount: 3,
      firstSeenAt: new Date("2026-11-18T10:00:00.000Z"),
      lastSeenAt: new Date("2026-11-19T15:00:00.000Z"),
      ipCount: 1,
      countryCodes: ["DE"],
      countryCount: 1,
      recentIps: [],
      approximate: false,
    };
    const statusFor = async (credential: string) =>
      (
        await body<{ keyStatus: unknown }>(
          await load(summaryRoute(), summaryUrl(slug, `credential=${credential}`), slug, cookie)
        )
      ).keyStatus;

    // Root keys keep no last use.
    expect(await statusFor(`root:${environment.id}:k9Qz`)).toEqual({
      lastUsedAt: null,
      end: {
        reason: "revoked",
        at: rotatedAt.toISOString(),
        workedUntil: graceUntil.toISOString(),
      },
    });
    expect(await statusFor(`key:${revokedKey.id}`)).toEqual({
      lastUsedAt: lastUsedAt.toISOString(),
      end: { reason: "revoked", at: rotatedAt.toISOString(), workedUntil: rotatedAt.toISOString() },
    });
    expect(await statusFor(`key:${liveKey.id}`)).toEqual({
      lastUsedAt: lastUsedAt.toISOString(),
      end: null,
    });
    expect(await statusFor(`oat:${expiredToken.id}`)).toMatchObject({
      lastUsedAt: null,
      end: { reason: "expired" },
    });
    // It stopped working when it expired, not when it was revoked later.
    expect(await statusFor(`key:${expiredThenRevoked.id}`)).toMatchObject({
      end: { reason: "expired", at: "2026-11-02T00:00:00.000Z" },
    });
    // A root key rotated without a grace period leaves no row: revoked, but when isn't kept.
    expect(await statusFor(`root:${environment.id}:zz99`)).toEqual({
      lastUsedAt: null,
      end: { reason: "revoked", at: null, workedUntil: null },
    });
    // The environment's current root key still works.
    expect(await statusFor(`root:${environment.id}:${environment.apiKey.slice(-4)}`)).toBeNull();
    // No audited events in the range, e.g. a key used only to trigger runs: its own rows still say
    // when it was last used and how it ended.
    summaryAnswer = null;
    expect(await statusFor(`key:${revokedKey.id}`)).toEqual({
      lastUsedAt: lastUsedAt.toISOString(),
      end: { reason: "revoked", at: rotatedAt.toISOString(), workedUntil: rotatedAt.toISOString() },
    });
    // Another org's key, a key picked by last 4 only, or a personal token: nothing to say.
    expect(await statusFor(`key:${otherOrgKey.id}`)).toBeNull();
    expect(await statusFor(`root:${environment.id}`)).toBeNull();
    expect(await statusFor("pat:any_token")).toBeNull();
  });

  // Catches: the summary covering other events than the page lists for the same URL: another range,
  // category, source or credential; or paging and the selected event leaking into it.
  it("sums up the events the page lists for the same URL", async () => {
    const { organization, cookie } = await setup();
    const filters = {
      credential: "root:env_1:k9Qz",
      category: "envvars",
      via: "api",
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-08T00:00:00.000Z",
    };
    const slug = organization.slug;
    const search = new URLSearchParams({ ...filters, cursor: "abc", event: "evt_1" });

    const response = await load(summaryRoute(), summaryUrl(slug, String(search)), slug, cookie);
    const answer = await body<{ search: string }>(response);
    expect(answer.search).toBe(auditLogSummarySearch(new URLSearchParams(filters)));
    expect(answer.search).not.toMatch(/cursor|event/);

    const page = pageUrl(slug, String(new URLSearchParams(filters)));
    expect((await load(pageRoute(), page, slug, cookie)).status).toBe(200);
    expect(listed).toHaveLength(1);
    const { cursor: _cursor, limit: _limit, ...listQuery } = listed[0]!;
    expect(summarized).toEqual([listQuery]);
    expect(summarized[0]).not.toHaveProperty("cursor");
  });

  // Catches: the page asking for a summary in another param order than the route echoes, e.g. for
  // "Occurred before" (an end date only): the page then never takes the answer and keeps loading.
  it("echoes the exact search the page asks with, for every kind of time range", async () => {
    const { organization, cookie } = await setup();
    const slug = organization.slug;
    const range = {
      from: Date.parse("2026-11-01T00:00:00Z"),
      to: Date.parse("2026-11-08T00:00:00Z"),
    };

    for (const time of [
      { period: "7d" },
      { to: "2026-11-08T00:00:00.000Z" },
      { from: "2026-11-01T00:00:00.000Z" },
      { from: "2026-11-01T00:00:00.000Z", to: "2026-11-08T00:00:00.000Z" },
    ]) {
      const filters = new URLSearchParams({ credential: "root:env_1:k9Qz", ...time });
      const search = auditLogSummaryRangeSearch(auditLogSummarySearch(filters), range);
      const answer = await body<{ search: string }>(
        await load(summaryRoute(), summaryUrl(slug, search), slug, cookie)
      );
      expect(answer.search, JSON.stringify(time)).toBe(search);
    }
  });

  // Catches: a relative range ("7 days") read again when the summary loads, after the list: the
  // summary's range then ends later than the list's, and its events and last seen go past it.
  it("sums up the list's own range when the range is relative", async () => {
    const { organization, cookie } = await setup();
    const slug = organization.slug;
    const filters = { credential: "root:env_1:k9Qz", period: "7d" };

    const loaded = await load(
      pageRoute(),
      pageUrl(slug, String(new URLSearchParams(filters))),
      slug,
      cookie
    );
    const { page } = await body<{ page: { range: { from: number; to: number } } }>(loaded);
    // The page renders, then loads the summary a little later.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const search = auditLogSummaryRangeSearch(
      auditLogSummarySearch(new URLSearchParams(filters)),
      page.range
    );
    await load(summaryRoute(), summaryUrl(slug, search), slug, cookie);

    expect(summarized).toHaveLength(1);
    expect(summarized[0]!.from).toEqual(listed[0]!.from);
    expect(summarized[0]!.to).toEqual(listed[0]!.to);
  });
});
