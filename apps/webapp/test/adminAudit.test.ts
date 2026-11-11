import type { PrismaClient } from "@trigger.dev/database";
import type { AdminAuditController, AdminAuditEvent } from "@trigger.dev/plugins";
import { postgresTest } from "@internal/testcontainers";
import { json } from "@remix-run/server-runtime";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/env.server", async () => {
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  return {
    env: withLegacyEncryptionKeyring({
      ADMIN_AUDIT_ENABLED: true,
      ADMIN_DASHBOARD_ENABLED: true,
      APP_ORIGIN: "http://localhost:3030",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      SESSION_SECRET: "test-session-secret",
      MAGIC_LINK_SECRET: "test-magic-link-secret",
      CLI_LOGIN_NETWORK_CHECK: "off",
      REQUIRE_PLUGINS: undefined,
    }),
  };
});

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
}));

import { withAdminAudit } from "~/services/adminAudit/adminAudit.server";
import { setAdminAuditController } from "~/services/adminAudit/adminAuditContext.server";
import {
  createPersonalAccessToken,
  requireAdminApiRequest,
} from "~/services/personalAccessToken.server";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";
import { redirectWithImpersonation } from "~/models/admin.server";

/** Implements the plugin contract by keeping events in memory, standing in for the cloud plugin. */
function collectingController(): AdminAuditController & { events: AdminAuditEvent[] } {
  const events: AdminAuditEvent[] = [];
  return { events, record: (event) => events.push(event), flush: async () => {} };
}

/** An admin API route as the routes write it: PAT admin auth first, then the work. */
const adminApiAction = withAdminAudit(async ({ request }: { request: Request }) => {
  await requireAdminApiRequest(request);
  if (request.body) await request.text();
  return json({ ok: true });
});

async function call(
  handler: (args: { request: Request }) => Promise<unknown>,
  path: string,
  init: RequestInit = {}
) {
  try {
    await handler({ request: new Request(`http://localhost${path}`, init) });
  } catch {}
}

async function seedUser(prisma: PrismaClient, admin: boolean) {
  db.client = prisma;
  return prisma.user.create({
    data: {
      email: `${admin ? "admin" : "member"}-${Math.random().toString(36).slice(2)}@example.com`,
      authenticationMethod: "MAGIC_LINK",
      admin,
    },
  });
}

describe("admin audit host wiring", () => {
  /** Catches: an admin API call with a PAT that leaves no record, or one that records the token value. */
  postgresTest(
    "records an admin PAT call with actor, token id, status and a redacted body",
    async ({ prisma }) => {
      const controller = collectingController();
      setAdminAuditController(Promise.resolve(controller));
      const admin = await seedUser(prisma, true);
      const pat = await createPersonalAccessToken({ name: "audit-test", userId: admin.id });

      await call(adminApiAction, "/admin/api/v1/workers", {
        method: "POST",
        headers: {
          authorization: `Bearer ${pat.token}`,
          "content-type": "application/json",
          "x-forwarded-for": "10.0.0.1, 203.0.113.10",
        },
        body: JSON.stringify({ name: "w1", apiKey: "tr_secret_value" }),
      });

      await vi.waitFor(() =>
        expect(controller.events.some((e) => e.activity === "api_call")).toBe(true)
      );
      const event = controller.events.find((e) => e.activity === "api_call")!;
      expect(event).toMatchObject({
        actor: {
          kind: "user_pat",
          userId: admin.id,
          email: admin.email,
          isAdmin: true,
          tokenId: pat.id,
        },
        srcEndpoint: { ip: "203.0.113.10" },
        http: { method: "POST", path: "/admin/api/v1/workers", status: 200 },
        bodySummary: { name: "w1", apiKey: "[redacted]" },
      });
      expect(JSON.stringify(controller.events)).not.toContain(pat.token);
    }
  );

  /** Catches: rejected attempts going unrecorded, which is when the trail matters most. */
  postgresTest(
    "records rejected attempts with the thrown status and without their bodies",
    async ({ prisma }) => {
      const controller = collectingController();
      setAdminAuditController(Promise.resolve(controller));
      const member = await seedUser(prisma, false);
      const pat = await createPersonalAccessToken({ name: "member", userId: member.id });

      await call(adminApiAction, "/admin/api/v1/feature-flags", {
        method: "POST",
        headers: { authorization: `Bearer ${pat.token}`, "content-type": "application/json" },
        body: JSON.stringify({ flag: true }),
      });
      await call(adminApiAction, "/admin/api/v1/feature-flags", { method: "POST" });

      await vi.waitFor(() => expect(controller.events).toHaveLength(2));
      const byStatus = Object.fromEntries(controller.events.map((e) => [e.http?.status, e]));
      expect(byStatus[403]).toMatchObject({
        actor: { kind: "user_pat", userId: member.id, isAdmin: false, tokenId: pat.id },
        bodySummary: null,
      });
      expect(byStatus[401]).toMatchObject({
        actor: { kind: "unauthenticated" },
        bodySummary: null,
      });
    }
  );

  /** Catches: a route that crashes after an admin authenticated leaving no record of the attempt. */
  postgresTest("records a crashed admin route as a 500 and rethrows", async ({ prisma }) => {
    const controller = collectingController();
    setAdminAuditController(Promise.resolve(controller));
    const admin = await seedUser(prisma, true);
    const pat = await createPersonalAccessToken({ name: "audit-test", userId: admin.id });
    const crashing = withAdminAudit(async ({ request }: { request: Request }) => {
      await requireAdminApiRequest(request);
      throw new Error("boom");
    });

    await expect(
      crashing({
        request: new Request("http://localhost/admin/api/v1/workers", {
          headers: { authorization: `Bearer ${pat.token}` },
        }),
      })
    ).rejects.toThrow("boom");

    await vi.waitFor(() =>
      expect(controller.events.some((e) => e.http?.status === 500)).toBe(true)
    );
  });

  /** Catches: a dashboard action recorded without knowing which admin made it. */
  postgresTest(
    "resolves the session user for session-authenticated admin routes",
    async ({ prisma }) => {
      const controller = collectingController();
      setAdminAuditController(Promise.resolve(controller));
      const admin = await seedUser(prisma, true);
      const session = await getUserSession(new Request("http://localhost/"));
      session.set("user", { userId: admin.id });
      const cookie = (await commitSession(session)).split(";")[0];
      const dashboardAction = withAdminAudit(async (_args: { request: Request }) =>
        json({ ok: true })
      );

      await call(dashboardAction, "/admin/feature-flags", { method: "POST", headers: { cookie } });

      await vi.waitFor(() => expect(controller.events).toHaveLength(1));
      expect(controller.events[0]).toMatchObject({
        activity: "dashboard_action",
        actor: { kind: "user_session", userId: admin.id, email: admin.email, isAdmin: true },
        http: { method: "POST", path: "/admin/feature-flags", status: 200 },
      });
    }
  );

  /** Catches: a database password inside a connection URL being copied into the immutable archive. */
  postgresTest("strips credentials from URLs in JSON and form bodies", async ({ prisma }) => {
    const controller = collectingController();
    setAdminAuditController(Promise.resolve(controller));
    const admin = await seedUser(prisma, true);
    const pat = await createPersonalAccessToken({ name: "audit-test", userId: admin.id });

    await call(adminApiAction, "/admin/api/v1/workers", {
      method: "POST",
      headers: { authorization: `Bearer ${pat.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        connectionUrl: "postgres://app:hunter2@db.internal:5432/main",
        dsn: "https://ch.internal:8443/?user=app&password=hunter3&secure=true",
        spaced: "https://alice:hun ter4@host/db",
        noSlashes: "https:alice:hunter5@host",
        atInPassword: "https://alice:p@hunter6@host:5432/x",
        queryInPassword: "https://user:hunter?7@db.internal/main",
        repeatedSchemes: "a:".repeat(30000),
      }),
    });
    await call(adminApiAction, "/admin/data-stores", {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat.token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ connectionUrl: "https://user:hunter2@ch.internal:8443" }),
    });

    await vi.waitFor(() => expect(controller.events.filter((e) => e.bodySummary)).toHaveLength(2));
    expect(
      controller.events.filter((e) => e.bodySummary?.connectionUrl === "[redacted]")
    ).toHaveLength(2);
    expect(controller.events.map((e) => e.bodySummary?.dsn)).toContain(
      "https://ch.internal:8443/?user=app&password=[redacted]&secure=true"
    );
    expect(JSON.stringify(controller.events)).not.toMatch(/hunter[2-7]/);
  });

  /** Catches: an admin minting a PAT without an event, or every user's PAT showing up as an admin mint. */
  postgresTest(
    "records PATs minted by admins only, with where they came from",
    async ({ prisma }) => {
      const controller = collectingController();
      setAdminAuditController(Promise.resolve(controller));
      const admin = await seedUser(prisma, true);
      const member = await seedUser(prisma, false);
      const source = { ip: "203.0.113.20", userAgent: "Mozilla/5.0" };

      const adminPat = await createPersonalAccessToken({
        name: "cli",
        userId: admin.id,
        auditSource: source,
      });
      await createPersonalAccessToken({ name: "cli", userId: member.id, auditSource: source });

      await vi.waitFor(() => expect(controller.events).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(controller.events).toHaveLength(1);
      expect(controller.events[0]).toMatchObject({
        activity: "pat_created",
        actor: { userId: admin.id, isAdmin: true },
        srcEndpoint: source,
        pat: { tokenId: adminPat.id, name: "cli" },
      });
    }
  );

  /**
   * Catches: impersonation that leaves no audit record. The `/@/orgs/<slug>` link starts it on a
   * GET, which no route wrapper records, so the record has to come from the shared start path.
   */
  postgresTest(
    "records an admin starting to impersonate, including from a GET link",
    async ({ prisma }) => {
      const controller = collectingController();
      setAdminAuditController(Promise.resolve(controller));
      const admin = await seedUser(prisma, true);
      const member = await seedUser(prisma, false);
      const org = await prisma.organization.create({
        data: {
          title: "Acme",
          slug: `acme-${Math.random().toString(36).slice(2, 10)}`,
          supportAccessMode: "ALLOW",
          members: { create: [{ userId: member.id }] },
        },
      });

      const response = await redirectWithImpersonation(
        new Request(`http://localhost:3030/@/orgs/${org.slug}`, {
          headers: { "x-forwarded-for": "203.0.113.9, 82.14.22.5", "user-agent": "Mozilla/5.0" },
        }),
        { userId: member.id, organizationSlug: org.slug, path: `/orgs/${org.slug}` },
        { id: admin.id, admin: true },
        prisma
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/orgs/${org.slug}`);

      await vi.waitFor(() => expect(controller.events).toHaveLength(1));
      expect(controller.events[0]).toMatchObject({
        activity: "impersonation_started",
        actor: {
          kind: "user_session",
          userId: admin.id,
          email: admin.email,
          isAdmin: true,
          impersonatedUserId: member.id,
        },
        srcEndpoint: { ip: "82.14.22.5", userAgent: "Mozilla/5.0" },
        http: { method: "GET", path: `/@/orgs/${org.slug}`, status: 302 },
        bodySummary: { organizationSlug: org.slug, access: "allow" },
      });
    }
  );
});
