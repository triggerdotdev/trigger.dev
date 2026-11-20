import type { AuditLogEvent, AuditLogEventQuery } from "@trigger.dev/plugins";
import type { PrismaClient } from "@trigger.dev/database";
import type { rbac as Rbac } from "~/services/rbac.server";
import { afterEach, describe, expect, vi } from "vitest";

// GET /api/v1/orgs/:orgParam/audit-events against a real database. The PAT is validated by the
// real RBAC fallback; only the ability is replaced, standing in for the enterprise RBAC plugin's
// role floor: a user can `manage:audit-logs` in an organization only where the test grants it.

vi.setConfig({ testTimeout: 60_000 });

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  /** `${userId}:${organizationId}` the test grants manage:audit-logs to. */
  auditReaders: new Set<string>(),
  /** Every grant everywhere, like the OSS fallback's permissive PAT ability. */
  permissive: false,
  /** The context each authentication computed the role floor for. */
  authContexts: [] as Array<{ organizationId?: string }>,
}));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});
vi.mock("~/env.server", async () => {
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  return {
    env: withLegacyEncryptionKeyring({
      SESSION_SECRET: "test-session-secret-for-audit-events-api",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      RBAC_FORCE_FALLBACK: true,
    }),
  };
});
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/rbac.server", async (importOriginal) => {
  const { rbac } = await importOriginal<{ rbac: typeof Rbac }>();
  return {
    rbac: {
      ...rbac,
      authenticatePat: async (
        request: Request,
        context: { organizationId?: string; projectId?: string }
      ) => {
        const result = await rbac.authenticatePat(request, context);
        if (!result.ok) return result;
        ctx.authContexts.push(context);
        const granted =
          ctx.permissive ||
          (context.organizationId !== undefined &&
            ctx.auditReaders.has(`${result.userId}:${context.organizationId}`));
        return {
          ...result,
          ability: {
            can: (action: string, resource: { type: string } | { type: string }[]) =>
              granted &&
              [resource].flat().some((r) => action === "manage" && r.type === "audit-logs"),
            canSuper: () => false,
          },
        };
      },
    },
  };
});

import { postgresTest } from "@internal/testcontainers";
import { loader } from "~/routes/api.v1.orgs.$orgParam.audit-events";
import { installAuditLogPlugin, uninstallAuditLogPlugin } from "./helpers/auditLogPlugin";
import { seedTestPAT } from "./helpers/seedTestPAT";

type Listing = (query: AuditLogEventQuery) => Promise<{
  events: unknown[];
  nextCursor: string | null;
}>;

let seedCounter = 0;

/** An org with audit log access unless `auditLogsAccess` is false. */
async function seedOrgWithMember(prisma: PrismaClient, { auditLogsAccess = true } = {}) {
  seedCounter += 1;
  const slug = `audit-api-${seedCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: {
      title: slug,
      slug,
      members: { create: { userId: user.id, role: "ADMIN" } },
      featureFlags: auditLogsAccess ? { hasAuditLogsAccess: true } : undefined,
    },
  });
  const pat = await seedTestPAT(prisma, user.id);
  return { user, organization, token: pat.token };
}

async function get(orgParam: string, query = "", token?: string) {
  const response = await loader({
    request: new Request(`https://api.trigger.dev/api/v1/orgs/${orgParam}/audit-events${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    params: { orgParam },
    context: {},
  } as any);
  return { status: response.status, body: (await response.json()) as any };
}

/** Records every query the plugin receives and answers with `listing`. */
function installListing(listing: Listing = async () => ({ events: [], nextCursor: null })) {
  const queries: AuditLogEventQuery[] = [];
  installAuditLogPlugin({
    listEvents: async (query) => {
      queries.push(query);
      return (await listing(query)) as never;
    },
  });
  return queries;
}

function storedEvent(organizationId: string): AuditLogEvent {
  return {
    category: "credentials",
    action: "api_key.rotated",
    id: "evt_1",
    occurredAt: new Date("2026-11-09T12:00:00.000Z"),
    organizationId,
    projectId: "proj_1",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    target: { type: "api_key", id: "key_1", name: "CI" },
    actor: { type: "user", id: "user_1" },
    credential: { kind: "pat", id: "pat_1", last4: "k9Qz", fingerprintId: "fp_internal" },
    onBehalfOf: { userId: "staff_internal" },
    source: "api",
    // As listEvents returns it: with the IP's location.
    endpoint: {
      ip: "203.0.113.7",
      userAgent: "curl/8",
      location: { countryCode: "GB", asn: 64500, asName: "Example ISP" },
    } as AuditLogEvent["endpoint"],
    origin: null,
    requestId: "req_1",
    changes: { name: { before: "old", after: "CI" } },
  };
}

afterEach(() => {
  uninstallAuditLogPlugin();
  ctx.auditReaders.clear();
  ctx.permissive = false;
  ctx.authContexts.length = 0;
});

describe("GET /api/v1/orgs/:orgParam/audit-events", () => {
  postgresTest("requires a valid personal access token", async ({ prisma }) => {
    ctx.prisma = prisma;
    const { organization } = await seedOrgWithMember(prisma);
    const queries = installListing();

    expect((await get(organization.slug)).status).toBe(401);
    expect((await get(organization.slug, "", "tr_pat_notarealtoken")).status).toBe(401);
    expect(queries).toHaveLength(0);
  });

  postgresTest("refuses a member without manage:audit-logs", async ({ prisma }) => {
    ctx.prisma = prisma;
    const { organization, token } = await seedOrgWithMember(prisma);
    const queries = installListing();

    const response = await get(organization.slug, "", token);

    expect(response.status).toBe(403);
    expect(queries).toHaveLength(0);
    // The role floor was computed for the organization the path names.
    expect(ctx.authContexts).toEqual([{ organizationId: organization.id }]);
  });

  postgresTest(
    "lists the organization's events without internal fields, by id or slug",
    async ({ prisma }) => {
      ctx.prisma = prisma;
      const { user, organization, token } = await seedOrgWithMember(prisma);
      ctx.auditReaders.add(`${user.id}:${organization.id}`);
      const stored = storedEvent(organization.id);
      const internalAuthEvent = {
        ...stored,
        id: "evt_auth",
        category: "auth",
        action: "auth.credential_rejected",
      };
      installListing(async () => ({
        events: [{ ...stored, internalNote: "x" }, internalAuthEvent],
        nextCursor: null,
      }));

      for (const orgParam of [organization.slug, organization.id]) {
        const response = await get(orgParam, "", token);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          data: [
            {
              category: "credentials",
              action: "api_key.rotated",
              id: "evt_1",
              occurredAt: "2026-11-09T12:00:00.000Z",
              organizationId: organization.id,
              projectId: "proj_1",
              environmentId: "env_1",
              environmentType: "PRODUCTION",
              target: { type: "api_key", id: "key_1", name: "CI" },
              actor: { type: "user", id: "user_1" },
              credential: { kind: "pat", id: "pat_1", last4: "k9Qz" },
              source: "api",
              endpoint: {
                ip: "203.0.113.7",
                userAgent: "curl/8",
                location: { countryCode: "GB", asn: 64500, asName: "Example ISP" },
              },
              origin: null,
              requestId: "req_1",
              changes: { name: { before: "old", after: "CI" } },
            },
          ],
          pagination: {},
        });
        const text = JSON.stringify(response.body);
        expect(text).not.toContain("fp_internal");
        expect(text).not.toContain("staff_internal");
        expect(text).not.toContain("internalNote");
        expect(text).not.toContain("evt_auth");
      }
    }
  );

  postgresTest("never reads another organization's events", async ({ prisma }) => {
    ctx.prisma = prisma;
    const own = await seedOrgWithMember(prisma);
    const other = await seedOrgWithMember(prisma);
    ctx.auditReaders.add(`${own.user.id}:${own.organization.id}`);
    ctx.auditReaders.add(`${other.user.id}:${other.organization.id}`);
    const queries = installListing();

    // A grant in one organization is not a grant in another.
    expect((await get(other.organization.slug, "", own.token)).status).toBe(403);

    // Even with an ability that allows everything (the OSS fallback's), membership decides.
    ctx.permissive = true;
    expect((await get(other.organization.slug, "", own.token)).status).toBe(404);
    ctx.permissive = false;

    // The organization can't be chosen through the query string.
    const smuggled = await get(
      own.organization.slug,
      `?organizationId=${other.organization.id}`,
      own.token
    );
    expect(smuggled.status).toBe(400);
    expect(queries).toHaveLength(0);

    // Every query the plugin sees is scoped to the path's organization.
    expect((await get(own.organization.slug, "", own.token)).status).toBe(200);
    expect(queries.map((query) => query.organizationId)).toEqual([own.organization.id]);
  });

  postgresTest("passes filters and the cursor through to the plugin", async ({ prisma }) => {
    ctx.prisma = prisma;
    const { user, organization, token } = await seedOrgWithMember(prisma);
    ctx.auditReaders.add(`${user.id}:${organization.id}`);
    const queries = installListing(async (query) => ({
      events: [storedEvent(organization.id)],
      nextCursor: query.cursor ? null : "opaque-cursor-1",
    }));

    const filters = new URLSearchParams({
      "filter[occurredAt][from]": "2026-11-01T00:00:00.000Z",
      "filter[occurredAt][to]": String(Date.parse("2026-11-10T00:00:00.000Z")),
      "filter[category]": "credentials,members",
      "filter[action]": "api_key.rotated, member.removed",
      "filter[actorId]": "user_1",
      "filter[projectId]": "proj_1",
      "filter[environmentId]": "env_1",
      "filter[keyLast4]": "k9Qz",
      "page[size]": "5",
    });
    const first = await get(organization.slug, `?${filters}`, token);
    expect(first.status).toBe(200);
    expect(first.body.pagination).toEqual({ next: "opaque-cursor-1" });

    filters.set("page[after]", first.body.pagination.next);
    const second = await get(organization.slug, `?${filters}`, token);
    expect(second.status).toBe(200);
    expect(second.body.pagination).toEqual({});

    const expected: AuditLogEventQuery = {
      organizationId: organization.id,
      from: new Date("2026-11-01T00:00:00.000Z"),
      to: new Date("2026-11-10T00:00:00.000Z"),
      categories: ["credentials", "members"],
      actions: ["api_key.rotated", "member.removed"],
      actorId: "user_1",
      projectId: "proj_1",
      environmentId: "env_1",
      keyLast4: "k9Qz",
      cursor: undefined,
      limit: 5,
    };
    expect(queries).toEqual([expected, { ...expected, cursor: "opaque-cursor-1" }]);
  });

  postgresTest("defaults the range and page size", async ({ prisma }) => {
    ctx.prisma = prisma;
    const { user, organization, token } = await seedOrgWithMember(prisma);
    ctx.auditReaders.add(`${user.id}:${organization.id}`);
    const queries = installListing();
    const before = Date.now();

    expect((await get(organization.slug, "", token)).status).toBe(200);

    expect(queries).toHaveLength(1);
    expect(queries[0].limit).toBe(20);
    expect(queries[0].from.toISOString()).toBe("2000-01-01T00:00:00.000Z");
    expect(queries[0].to.getTime()).toBeGreaterThanOrEqual(before);
    expect(queries[0].to.getTime()).toBeLessThanOrEqual(Date.now());
  });

  postgresTest("rejects invalid query parameters", async ({ prisma }) => {
    ctx.prisma = prisma;
    const { user, organization, token } = await seedOrgWithMember(prisma);
    ctx.auditReaders.add(`${user.id}:${organization.id}`);
    const queries = installListing();

    for (const query of [
      "?page[size]=101",
      "?page[size]=0",
      "?filter[category]=auth",
      "?filter[action]=auth.credential_rejected",
      "?filter[keyLast4]=abc",
      "?filter[occurredAt][from]=yesterday",
      "?filter[occurredAt][from]=2026-02-30",
      "?filter[occurredAt][from]=2026-02-29T00:00:00Z",
      "?filter[occurredAt][to]=2026-11-01T24:00:00Z",
      "?filter[occurredAt][from]=2026-11-10T00:00:00Z&filter[occurredAt][to]=2026-11-01T00:00:00Z",
      "?unknown=1",
    ]) {
      const response = await get(organization.slug, query, token);
      expect({ query, status: response.status }).toEqual({ query, status: 400 });
    }
    expect(queries).toHaveLength(0);
  });

  postgresTest("maps the plugin's errors", async ({ prisma }) => {
    ctx.prisma = prisma;
    const { user, organization, token } = await seedOrgWithMember(prisma);
    ctx.auditReaders.add(`${user.id}:${organization.id}`);

    const failWith = (name: string, message: string) =>
      installListing(async () => {
        const error = new Error(message);
        error.name = name;
        throw error;
      });

    failWith("AuditLogQueryError", "Invalid audit log cursor");
    expect(await get(organization.slug, "?page[after]=garbage", token)).toEqual({
      status: 400,
      body: { error: "Invalid audit log cursor" },
    });

    failWith("AuditLogReadError", "Audit log query failed: ClickHouse could not be reached");
    const unavailable = await get(organization.slug, "", token);
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(unavailable.body)).not.toContain("ClickHouse");

    failWith("Error", "something else");
    expect((await get(organization.slug, "", token)).status).toBe(500);
  });

  // Catches: the API answering for an org before it has audit log access, or keeping it from one
  // that has it through the global flag.
  postgresTest("answers 404 until the org has audit log access", async ({ prisma }) => {
    ctx.prisma = prisma;
    const { user, organization, token } = await seedOrgWithMember(prisma, {
      auditLogsAccess: false,
    });
    ctx.auditReaders.add(`${user.id}:${organization.id}`);
    const queries = installListing();

    expect(await get(organization.slug, "", token)).toEqual({
      status: 404,
      body: { error: "Not found" },
    });
    expect(queries).toHaveLength(0);

    await prisma.featureFlag.create({ data: { key: "hasAuditLogsAccess", value: true } });
    expect((await get(organization.slug, "", token)).status).toBe(200);
    expect(queries).toHaveLength(1);
  });

  postgresTest("answers 501 without the audit log plugin", async ({ prisma }) => {
    ctx.prisma = prisma;
    const { user, organization, token } = await seedOrgWithMember(prisma);
    ctx.auditReaders.add(`${user.id}:${organization.id}`);
    // What the host's loader resolves to when the plugin isn't installed.
    const global = globalThis as any;
    global.__trigger_singletons ??= {};
    global.__trigger_singletons.auditLogController = Promise.resolve(null);

    expect(await get(organization.slug, "", token)).toEqual({
      status: 501,
      body: {
        error: "Audit logs aren't available on this instance.",
        code: "audit_logs_not_available",
      },
    });
    // Auth still comes first: no answer about the instance to a caller who can't view audit logs.
    ctx.auditReaders.clear();
    expect((await get(organization.slug, "", token)).status).toBe(403);
  });
});
