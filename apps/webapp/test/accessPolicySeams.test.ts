import type { AccessPolicyController } from "@trigger.dev/plugins";
import type { PrismaClient } from "@trigger.dev/database";
import type * as AccessPolicyModule from "~/services/accessPolicy.server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  prisma: null as PrismaClient | null,
  controller: null as AccessPolicyController | null,
}));

vi.mock("~/db.server", async () => {
  const { Prisma, boundedIn } = await import("@trigger.dev/database");
  // Forwards to the current test's client, so singletons built at import time still reach it.
  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        const value = (holder.prisma as any)?.[prop];
        return typeof value === "function" ? value.bind(holder.prisma) : value;
      },
    }
  );
  return { Prisma, boundedIn, prisma: client, $replica: client };
});

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    getUserRole: async () => null,
    setUserRole: async () => ({ ok: true }),
  },
}));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardAction: (_options: unknown, handler: unknown) => handler,
  dashboardLoader: (_options: unknown, handler: unknown) => handler,
}));

// The real helpers, handed the test's fake controller instead of loading the plugin.
vi.mock("~/services/accessPolicy.server", async (importOriginal) => {
  const actual = await importOriginal<typeof AccessPolicyModule>();
  const source = () => ({ controller: holder.controller });
  return {
    ...actual,
    isSignInAllowed: (check: any) => actual.isSignInAllowed(check, source()),
    isSessionValid: (check: any) => actual.isSessionValid(check, source()),
    checkSession: (check: any) => actual.checkSession(check, source()),
    isOrganizationJoinAllowed: (check: any) => actual.isOrganizationJoinAllowed(check, source()),
    forcedSupportAccess: (ids: string[]) => actual.forcedSupportAccess(ids, source()),
    getOrganizationAdminPanel: (organizationId: string) =>
      actual.getOrganizationAdminPanel(organizationId, source()),
    performOrganizationAdminAction: (input: any) =>
      actual.performOrganizationAdminAction(input, source()),
  };
});

import { postgresTest } from "@internal/testcontainers";
import { acceptInvite, INVITE_NOT_FOUND } from "~/models/member.server";
import { ensureOrgMember } from "~/models/orgMember.server";
import { action } from "~/routes/admin.back-office.orgs.$orgId";
import { authenticator } from "~/services/auth.server";
import { postAuthentication } from "~/services/postAuth.server";
import { getUserId } from "~/services/session.server";
import { SESSION_ISSUED_AT_KEY } from "~/services/sessionDuration.server";
import { sessionStorage } from "~/services/sessionStorage.server";
import { SupportAccessService } from "~/services/supportAccess.server";
import { supportAccessState } from "~/components/admin/supportAccessState";
import { adminGetOrganizations } from "~/models/admin.server";
import { assertEmailAllowed } from "~/utils/email";
import { seedTestUser } from "./helpers/seedTestSession";

function fakeController(overrides: Partial<AccessPolicyController> = {}) {
  const controller = {
    checkSignIn: vi.fn(async () => ({ allowed: true as const })),
    checkSession: vi.fn(async () => ({ valid: true as const })),
    checkOrganizationJoin: vi.fn(async () => ({ allowed: true as const })),
    forcedSupportAccess: vi.fn(async () => [] as string[]),
    organizationAdminPanel: vi.fn(async () => null),
    performOrganizationAdminAction: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
  holder.controller = controller as AccessPolicyController;
  return controller;
}

async function thrownBy(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeEach(() => {
  holder.controller = null;
});

describe("session policy on authenticated requests", () => {
  async function cookieFor(userId: string, issuedAt: number) {
    const session = await sessionStorage.getSession();
    session.set(authenticator.sessionKey, { userId });
    session.set(SESSION_ISSUED_AT_KEY, issuedAt);
    return (await sessionStorage.commitSession(session)).split(";")[0];
  }

  // Catches: a refused session kept open, or ended via GET /logout, which loops for navigations
  // that are not same-origin.
  postgresTest("ends a session the policy refuses, in the response", async ({ prisma }) => {
    holder.prisma = prisma;
    const user = await seedTestUser(prisma);
    const issuedAt = Date.now() - 60_000;
    const cookie = await cookieFor(user.id, issuedAt);
    const controller = fakeController({
      checkSession: vi.fn(async () => ({ valid: false as const })),
    });

    const thrown = await thrownBy(() =>
      getUserId(new Request("https://example.test/orgs", { headers: { Cookie: cookie } }))
    );

    expect(controller.checkSession).toHaveBeenCalledWith({ userId: user.id, issuedAt });
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("location")).toBe("/");
    expect((thrown as Response).headers.get("set-cookie")).toMatch(
      /^__session=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/
    );
  });

  // Catches: the host ignoring the deadline the plugin returned and ending a session it should keep,
  // or keeping one past a plugin-supplied deadline.
  postgresTest(
    "enforces the deadline the plugin returns without its own read",
    async ({ prisma }) => {
      holder.prisma = prisma;
      const user = await seedTestUser(prisma);
      const cookie = await cookieFor(user.id, Date.now());
      const controller = fakeController({
        checkSession: vi.fn(async () => ({
          valid: true as const,
          nextSessionEnd: new Date(Date.now() - 60_000),
        })),
      });
      const findFirst = vi.spyOn(prisma.user, "findFirst");

      const response = await thrownBy(() =>
        getUserId(new Request("https://example.test/orgs", { headers: { Cookie: cookie } }))
      );

      expect(controller.checkSession).toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(302);
      findFirst.mockRestore();
    }
  );

  postgresTest("keeps a session the policy accepts", async ({ prisma }) => {
    holder.prisma = prisma;
    const user = await seedTestUser(prisma);
    const cookie = await cookieFor(user.id, Date.now());
    fakeController();

    await expect(
      getUserId(new Request("https://example.test/orgs", { headers: { Cookie: cookie } }))
    ).resolves.toBe(user.id);
  });

  // Catches: a check that can't run letting the session through.
  postgresTest("ends the session when the check throws", async ({ prisma }) => {
    holder.prisma = prisma;
    const user = await seedTestUser(prisma);
    const cookie = await cookieFor(user.id, Date.now());
    fakeController({
      checkSession: vi.fn(async () => {
        throw new Error("database down");
      }),
    });

    const thrown = await thrownBy(() =>
      getUserId(new Request("https://example.test/orgs", { headers: { Cookie: cookie } }))
    );
    expect((thrown as Response).headers.get("location")).toBe("/");
  });
});

describe("postAuthentication", () => {
  // Catches: a refused user completing a fresh login.
  it("refuses a sign-in the policy refuses", async () => {
    const controller = fakeController({
      checkSession: vi.fn(async () => ({ valid: false as const })),
    });
    const before = Date.now();

    await expect(
      postAuthentication({
        user: { id: "user_refused" } as any,
        loginMethod: "MAGIC_LINK",
        isNewUser: false,
      })
    ).rejects.toThrow("This account has been disabled.");
    const [check] = controller.checkSession.mock.calls[0] as unknown as [
      { userId: string; issuedAt: number },
    ];
    expect(check.userId).toBe("user_refused");
    expect(check.issuedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("assertEmailAllowed", () => {
  // Catches: a refused email signing in or up.
  it("refuses an email the policy refuses", async () => {
    const controller = fakeController({
      checkSignIn: vi.fn(async () => ({ allowed: false as const })),
    });

    await expect(assertEmailAllowed("someone@example.com")).rejects.toThrow(
      "This email address isn't allowed to sign in on this instance."
    );
    expect(controller.checkSignIn).toHaveBeenCalledWith({
      email: "someone@example.com",
      domainBlocked: false,
    });
  });

  it("allows an email the policy allows", async () => {
    fakeController();
    await expect(assertEmailAllowed("someone@example.com")).resolves.toBeUndefined();
  });

  // Catches: an instance without the plugin refusing everyone.
  it("allows an email when no policy is loaded", async () => {
    holder.controller = null;
    await expect(assertEmailAllowed("someone@example.com")).resolves.toBeUndefined();
  });
});

describe("acceptInvite", () => {
  // Catches: a pending invite adding a member to an organization the policy closed to joiners.
  postgresTest("refuses an invite the policy refuses, as not found", async ({ prisma }) => {
    holder.prisma = prisma;
    const s = Math.random().toString(36).slice(2, 10);
    const inviter = await prisma.user.create({
      data: { email: `inviter-${s}@example.test`, authenticationMethod: "MAGIC_LINK" },
    });
    const invitee = await prisma.user.create({
      data: { email: `invitee-${s}@example.test`, authenticationMethod: "MAGIC_LINK" },
    });
    const organization = await prisma.organization.create({
      data: {
        title: `closed-${s}`,
        slug: `closed-${s}`,
        isActivated: true,
        members: { create: { userId: inviter.id, role: "ADMIN" } },
      },
    });
    const invite = await prisma.orgMemberInvite.create({
      data: { email: invitee.email, organizationId: organization.id, inviterId: inviter.id },
    });
    const controller = fakeController({
      checkOrganizationJoin: vi.fn(async () => ({ allowed: false as const })),
    });
    const accept = () =>
      acceptInvite({ inviteId: invite.id, user: { id: invitee.id, email: invitee.email } });

    await expect(accept()).rejects.toThrow(INVITE_NOT_FOUND);
    expect(controller.checkOrganizationJoin).toHaveBeenCalledWith({
      organizationId: organization.id,
    });
    expect(
      await prisma.orgMember.count({
        where: { organizationId: organization.id, userId: invitee.id },
      })
    ).toBe(0);

    controller.checkOrganizationJoin.mockResolvedValue({ allowed: true });
    const { organization: joined } = await accept();
    expect(joined.id).toBe(organization.id);
  });
});

describe("ensureOrgMember", () => {
  // Catches: single sign-on or directory provisioning adding a member the policy refuses.
  postgresTest("refuses a provisioned membership the policy refuses", async ({ prisma }) => {
    holder.prisma = prisma;
    const s = Math.random().toString(36).slice(2, 10);
    const user = await prisma.user.create({
      data: { email: `jit-${s}@example.test`, authenticationMethod: "MAGIC_LINK" },
    });
    const organization = await prisma.organization.create({
      data: { title: `closed-${s}`, slug: `closed-${s}`, isActivated: true },
    });
    const controller = fakeController({
      checkOrganizationJoin: vi.fn(async () => ({ allowed: false as const })),
    });
    const provision = () =>
      ensureOrgMember({
        userId: user.id,
        organizationId: organization.id,
        roleId: null,
        source: "sso_jit",
      });

    await expect(provision()).rejects.toThrow("not accepting new members");
    expect(
      await prisma.orgMember.count({ where: { organizationId: organization.id, userId: user.id } })
    ).toBe(0);

    controller.checkOrganizationJoin.mockResolvedValue({ allowed: true });
    expect((await provision()).created).toBe(true);
  });
});

describe("support access", () => {
  // Catches: staff locked out of an organization the policy forces open while it requires requests.
  postgresTest("allows an organization the policy forces open", async ({ prisma }) => {
    holder.prisma = prisma;
    const s = Math.random().toString(36).slice(2, 10);
    const member = await prisma.user.create({
      data: { email: `member-${s}@example.test`, authenticationMethod: "MAGIC_LINK" },
    });
    const admin = await prisma.user.create({
      data: { email: `staff-${s}@example.test`, authenticationMethod: "MAGIC_LINK", admin: true },
    });
    const organization = await prisma.organization.create({
      data: {
        title: `forced-${s}`,
        slug: `forced-${s}`,
        isActivated: true,
        supportAccessMode: "REQUIRES_REQUEST",
        members: { create: { userId: member.id, role: "ADMIN" } },
      },
    });
    const controller = fakeController();
    const service = new SupportAccessService(prisma);
    const resolve = () =>
      service.resolveSessionAccess({ organizationSlug: organization.slug, userId: member.id });

    expect((await resolve())._unsafeUnwrap().type).toBe("request_required");

    controller.forcedSupportAccess.mockResolvedValue([organization.id]);
    expect((await resolve())._unsafeUnwrap()).toEqual({
      type: "allow",
      organizationId: organization.id,
    });
    expect(controller.forcedSupportAccess).toHaveBeenCalledWith([organization.id]);

    const { organizations } = await adminGetOrganizations(admin.id, { search: `forced-${s}` });
    const listed = organizations.find((o) => o.id === organization.id)!;
    expect(listed.supportAccessForced).toBe(true);
    expect(supportAccessState(listed)).toBe("allow");
  });
});

describe("back office organization plugin actions", () => {
  const ORG_ID = "org_plugin_route";
  const ADMIN_ID = "admin_plugin_route";

  async function post(fields: Record<string, string>) {
    const request = new Request(`https://localhost/admin/back-office/orgs/${ORG_ID}`, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    try {
      return (await (action as any)({
        request,
        params: { orgId: ORG_ID },
        user: { id: ADMIN_ID },
        context: {},
      })) as Response;
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  }

  // Catches: a plugin action not reaching the plugin, or reaching it with the prefix or intent field.
  it("forwards the intent and fields to the plugin", async () => {
    const controller = fakeController();
    const res = await post({ intent: "plugin:lock", reason: "abuse", confirmation: "LOCK" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/admin/back-office/orgs/${ORG_ID}?saved=plugin-panel`
    );
    expect(controller.performOrganizationAdminAction).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      adminUserId: ADMIN_ID,
      intent: "lock",
      fields: { reason: "abuse", confirmation: "LOCK" },
    });
  });

  // Catches: a refused plugin action reported as saved.
  it("returns the plugin's errors when it refuses", async () => {
    const errors = { confirmation: ["Type LOCK to confirm."] };
    fakeController({
      performOrganizationAdminAction: vi.fn(async () => ({ ok: false as const, errors })),
    });
    const res = await post({ intent: "plugin:lock", confirmation: "nope" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.json ?? body).toMatchObject({ section: "plugin-panel", errors });
  });

  // Catches: a plugin intent silently succeeding on an instance without the plugin.
  it("refuses a plugin intent when no policy is loaded", async () => {
    holder.controller = null;
    const res = await post({ intent: "plugin:lock" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.json ?? body).toMatchObject({ errors: { intent: ["Unknown action."] } });
  });
});
