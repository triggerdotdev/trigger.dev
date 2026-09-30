import type { PrismaClient } from "@trigger.dev/database";
import { containerTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { redirectWithImpersonation } from "~/models/admin.server";
import { createCookieSessionStorage } from "@remix-run/node";
import { env } from "~/env.server";
import { getImpersonationId, getImpersonationState } from "~/services/impersonation.server";

vi.setConfig({ testTimeout: 30_000 });

const DAY_S = 24 * 60 * 60;

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

async function seed(prisma: PrismaClient, mode: "ALLOW" | "REQUIRES_REQUEST") {
  const admin = await prisma.user.create({
    data: {
      email: `admin-${suffix()}@test.local`,
      authenticationMethod: "MAGIC_LINK",
      admin: true,
    },
  });
  const member = await prisma.user.create({
    data: { email: `member-${suffix()}@test.local`, authenticationMethod: "MAGIC_LINK" },
  });
  const org = await prisma.organization.create({
    data: {
      title: "Acme",
      slug: `acme-${suffix()}`,
      supportAccessMode: mode,
      members: { create: [{ userId: member.id }] },
    },
  });
  return { admin, member, org };
}

function start(
  prisma: PrismaClient,
  admin: { id: string },
  userId: string,
  organizationSlug: string
) {
  return redirectWithImpersonation(
    new Request("http://localhost:3030/admin", { method: "POST" }),
    { userId, organizationSlug, path: `/orgs/${organizationSlug}` },
    { id: admin.id, admin: true },
    prisma
  );
}

function maxAge(response: Response) {
  const match = /Max-Age=(\d+)/i.exec(response.headers.get("set-cookie") ?? "");
  return match ? Number(match[1]) : undefined;
}

async function impersonatingWith(response: Response, userId: string, orgSlug: string) {
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  const state = await getImpersonationState(
    new Request(`http://localhost:3030/orgs/${orgSlug}`, { headers: { Cookie: cookie } }),
    userId
  );
  return state.isImpersonating;
}

async function sessionCookie(response: Response) {
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

function asCustomer(cookie: string, path: string, referer?: string, method = "GET") {
  return getImpersonationId(
    new Request(`http://localhost:3030${path}`, {
      method,
      headers: referer ? { Cookie: cookie, Referer: referer } : { Cookie: cookie },
    })
  );
}

describe("Support Access session gate", () => {
  containerTest("an Allow org starts a session as before", async ({ prisma }) => {
    const { admin, member, org } = await seed(prisma, "ALLOW");

    const response = await start(prisma, admin, member.id, org.slug);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/orgs/${org.slug}`);
    expect(maxAge(response)).toBe(DAY_S);
    expect(await impersonatingWith(response, member.id, org.slug)).toBe(true);
    expect(await prisma.impersonationAuditLog.count({ where: { targetId: member.id } })).toBe(1);
  });

  containerTest(
    "a request org without an approval sends staff to the request dialog",
    async ({ prisma }) => {
      const { admin, member, org } = await seed(prisma, "REQUIRES_REQUEST");

      const response = await start(prisma, admin, member.id, org.slug);

      expect(response.headers.get("location")).toBe(
        `/admin/orgs?search=${org.slug}&supportAccessRequest=1`
      );
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await prisma.impersonationAuditLog.count({ where: { targetId: member.id } })).toBe(0);
    }
  );

  containerTest(
    "a request org with an approval starts a session capped at the approval",
    async ({ prisma }) => {
      const { admin, member, org } = await seed(prisma, "REQUIRES_REQUEST");
      const expiresInS = 2 * 60 * 60;
      await prisma.supportAccessRequest.create({
        data: {
          organizationId: org.id,
          requestedById: admin.id,
          reason: "stuck runs",
          status: "APPROVED",
          approvedById: member.id,
          approvedAt: new Date(),
          expiresAt: new Date(Date.now() + expiresInS * 1000),
        },
      });

      const response = await start(prisma, admin, member.id, org.slug);

      expect(response.headers.get("location")).toBe(`/orgs/${org.slug}`);
      const age = maxAge(response)!;
      expect(age).toBeLessThanOrEqual(expiresInS);
      expect(age).toBeGreaterThan(expiresInS - 60);
      expect(await impersonatingWith(response, member.id, org.slug)).toBe(true);
    }
  );

  containerTest("an expired approval does not count", async ({ prisma }) => {
    const { admin, member, org } = await seed(prisma, "REQUIRES_REQUEST");
    await prisma.supportAccessRequest.create({
      data: {
        organizationId: org.id,
        requestedById: admin.id,
        reason: "old",
        status: "APPROVED",
        approvedAt: new Date(Date.now() - 8 * DAY_S * 1000),
        expiresAt: new Date(Date.now() - DAY_S * 1000),
      },
    });

    const response = await start(prisma, admin, member.id, org.slug);

    expect(response.headers.get("location")).toContain("supportAccessRequest=1");
  });

  containerTest(
    "an Allow session cannot open an org that requires a request",
    async ({ prisma }) => {
      const { admin, member, org: allowOrg } = await seed(prisma, "ALLOW");
      const requestOrg = await prisma.organization.create({
        data: {
          title: "Locked",
          slug: `locked-${suffix()}`,
          supportAccessMode: "REQUIRES_REQUEST",
          members: { create: [{ userId: member.id }] },
        },
      });

      const response = await start(prisma, admin, member.id, allowOrg.slug);
      const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
      const at = (path: string) =>
        getImpersonationId(
          new Request(`http://localhost:3030${path}`, { headers: { Cookie: cookie } })
        );

      expect(await at(`/orgs/${allowOrg.slug}/projects`)).toBe(member.id);
      expect(await at(`/orgs/${requestOrg.slug}/projects`)).toBeUndefined();
      expect(await at(`/resources/orgs/${requestOrg.slug}/projects/p/env/dev`)).toBeUndefined();
    }
  );

  containerTest("an Allow session is limited to the org it was opened for", async ({ prisma }) => {
    const { admin, member, org } = await seed(prisma, "ALLOW");
    const otherAllowOrg = await prisma.organization.create({
      data: {
        title: "Other",
        slug: `other-${suffix()}`,
        members: { create: [{ userId: member.id }] },
      },
    });

    const cookie = await sessionCookie(await start(prisma, admin, member.id, org.slug));

    expect(await asCustomer(cookie, `/orgs/${org.slug}`)).toBe(member.id);
    expect(await asCustomer(cookie, `/orgs/${otherAllowOrg.slug}`)).toBeUndefined();
  });

  containerTest(
    "ID-keyed and account routes only run as the customer from inside the session's org",
    async ({ prisma }) => {
      const { admin, member, org } = await seed(prisma, "ALLOW");
      const cookie = await sessionCookie(await start(prisma, admin, member.id, org.slug));
      const fromOrg = `http://localhost:3030/orgs/${org.slug}/projects/p/env/dev/runs`;

      expect(await asCustomer(cookie, "/resources/taskruns/run_1/cancel", fromOrg)).toBe(member.id);
      expect(await asCustomer(cookie, "/resources/taskruns/run_1/cancel")).toBeUndefined();
      expect(await asCustomer(cookie, "/projects/v3/proj_1/metrics")).toBeUndefined();
      expect(await asCustomer(cookie, "/account/tokens", fromOrg)).toBe(member.id);
      expect(await asCustomer(cookie, "/account/tokens", fromOrg, "POST")).toBeUndefined();
      expect(
        await asCustomer(cookie, "/resources/account/mfa/setup", fromOrg, "POST")
      ).toBeUndefined();
    }
  );

  containerTest("a cookie from before org lists is no longer honoured", async ({ prisma }) => {
    const { member, org } = await seed(prisma, "ALLOW");
    // Pre-deploy cookies carried only the impersonated user id.
    const legacyStorage = createCookieSessionStorage({
      cookie: { name: "__impersonate", path: "/", secrets: [env.SESSION_SECRET] },
    });
    const legacy = await legacyStorage.getSession();
    legacy.set("impersonatedUserId", member.id);
    const cookie = (await legacyStorage.commitSession(legacy)).split(";")[0];

    expect(await asCustomer(cookie, `/orgs/${org.slug}`)).toBeUndefined();
  });

  containerTest("a request-mode session is pinned to the approved org", async ({ prisma }) => {
    const { admin, member, org } = await seed(prisma, "REQUIRES_REQUEST");
    const otherAllowOrg = await prisma.organization.create({
      data: {
        title: "Other",
        slug: `other-${suffix()}`,
        members: { create: [{ userId: member.id }] },
      },
    });
    await prisma.supportAccessRequest.create({
      data: {
        organizationId: org.id,
        requestedById: admin.id,
        reason: "x",
        status: "APPROVED",
        approvedAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const response = await start(prisma, admin, member.id, org.slug);
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    const at = (path: string) =>
      getImpersonationId(
        new Request(`http://localhost:3030${path}`, { headers: { Cookie: cookie } })
      );

    expect(await at(`/orgs/${org.slug}`)).toBe(member.id);
    expect(await at(`/orgs/${otherAllowOrg.slug}`)).toBeUndefined();
  });

  containerTest("a user who is not a member of the org is refused", async ({ prisma }) => {
    const { admin, org } = await seed(prisma, "ALLOW");
    const outsider = await prisma.user.create({
      data: { email: `outsider-${suffix()}@test.local`, authenticationMethod: "MAGIC_LINK" },
    });

    const response = await start(prisma, admin, outsider.id, org.slug);

    expect(response.headers.get("location")).toBe("/admin");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("__impersonate=");
  });
});
