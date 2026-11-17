import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import type { PrismaClient, PrismaTransactionClient } from "@trigger.dev/database";

const prismaHolder = vi.hoisted(() => ({
  client: null as PrismaClient | null,
}));

vi.mock("~/env.server", async (original) =>
  (await import("./helpers/auditLogPlugin")).auditRecordingEnv(await original())
);

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");

  // Resolved on use, not on import: modules keep a reference when they load (featureFlags.server.ts
  // builds `flag` from `prisma`), before a test has set its client.
  const testClient = new Proxy({} as PrismaClient, {
    get(_target, property) {
      const client = prismaHolder.client;
      if (!client) {
        throw new Error("test prisma not set");
      }
      const value = Reflect.get(client, property);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });

  return {
    Prisma,
    $transaction: (
      client: PrismaClient,
      _name: string,
      callback: (tx: PrismaTransactionClient) => Promise<unknown>,
      options?: Parameters<PrismaClient["$transaction"]>[1]
    ) => client.$transaction(callback, options),
    prisma: testClient,
    $replica: testClient,
  };
});

// The RBAC plugin is closed source and not installed here. Tests run on the real open-source
// fallback by default. It has no roles (internal-packages/rbac/src/fallback.ts: `allRoles()` is [],
// `getUserRole` is null and `setUserRole` returns "RBAC plugin not installed"), so tests that assign
// or read roles call `useRoleStandIn()`. The stand-in replaces only the role methods, with the
// contract of enterprise/packages/plugins/src/rbac/controller.ts: a role read is null for a user who
// isn't a member, else their assigned role, else the legacy OrgMember.role mapping (ADMIN -> Owner,
// MEMBER -> Admin). `setUserRole` writes the assignment whether or not the user is a member, and
// refuses to demote the org's last Owner. Session authentication stays the real fallback's.
type FakeRole = { id: string; name: string; isSystem: boolean };
const rbacHolder = vi.hoisted(() => ({
  /** Whether the role methods come from the stand-in instead of the fallback. */
  roleStandIn: false,
  roles: {
    owner: { id: "role_owner", name: "Owner", isSystem: true },
    admin: { id: "role_admin", name: "Admin", isSystem: true },
    developer: { id: "role_developer", name: "Developer", isSystem: true },
  } as Record<string, { id: string; name: string; isSystem: boolean }>,
  assignments: new Map<string, { id: string; name: string; isSystem: boolean }>(),
  /** Makes the next `getUserRole` throw, like a failed database read. */
  failNextGetUserRole: false,
  /** How many times each read ran, to tell which reads a change made. */
  reads: { getUserRole: 0, allRoles: 0 },
  /** While set, `allRoles` waits for it, like a slow database read. */
  allRolesGate: null as Promise<void> | null,
}));

vi.mock("~/services/rbac.server", async () => {
  const { default: rbacPlugin } = await import("@trigger.dev/rbac");
  const key = (userId: string, organizationId: string) => `${organizationId}:${userId}`;
  const legacyRoleKeys: Record<string, string> = { ADMIN: "owner", MEMBER: "admin" };
  const isOwner = (role: FakeRole | null) => role?.name === "Owner" && role.isSystem;

  async function effectiveRole(userId: string, organizationId: string): Promise<FakeRole | null> {
    const member = await prismaHolder.client!.orgMember.findFirst({
      where: { userId, organizationId },
      select: { role: true },
    });
    if (!member) return null;
    return (
      rbacHolder.assignments.get(key(userId, organizationId)) ??
      rbacHolder.roles[legacyRoleKeys[member.role]!] ??
      null
    );
  }

  const roleStandIn: Record<string, unknown> = {
    async getUserRole({ userId, organizationId }: { userId: string; organizationId: string }) {
      rbacHolder.reads.getUserRole++;
      if (rbacHolder.failNextGetUserRole) {
        rbacHolder.failNextGetUserRole = false;
        throw new Error("role read failed");
      }
      return effectiveRole(userId, organizationId);
    },
    async getUserRoles(userIds: string[], organizationId: string) {
      return new Map(
        await Promise.all(
          userIds.map(
            async (userId) => [userId, await effectiveRole(userId, organizationId)] as const
          )
        )
      );
    },
    async allRoles() {
      rbacHolder.reads.allRoles++;
      await rbacHolder.allRolesGate;
      return Object.values(rbacHolder.roles);
    },
    async setUserRole(params: { userId: string; organizationId: string; roleId: string }) {
      const role = Object.values(rbacHolder.roles).find((r) => r.id === params.roleId);
      if (!role) return { ok: false, error: "Role not found" };
      const members = await prismaHolder.client!.orgMember.findMany({
        where: { organizationId: params.organizationId },
        select: { userId: true },
      });
      const owners: string[] = [];
      for (const { userId } of members) {
        if (isOwner(await effectiveRole(userId, params.organizationId))) owners.push(userId);
      }
      if (!isOwner(role) && owners.length === 1 && owners[0] === params.userId) {
        return {
          ok: false,
          error: "An organisation must have at least one Owner",
          code: "last_owner",
        };
      }
      rbacHolder.assignments.set(key(params.userId, params.organizationId), role);
      return { ok: true };
    },
    async removeUserRole({ userId, organizationId }: { userId: string; organizationId: string }) {
      rbacHolder.assignments.delete(key(userId, organizationId));
      return { ok: true };
    },
  };

  // One real fallback per test database, built on the client the test set.
  const fallbacks = new WeakMap<PrismaClient, object>();
  function fallback() {
    const client = prismaHolder.client!;
    let controller = fallbacks.get(client);
    if (!controller) {
      controller = rbacPlugin.create({ primary: client, replica: client }, { forceFallback: true });
      fallbacks.set(client, controller);
    }
    return controller;
  }

  const rbac = new Proxy(
    {},
    {
      get(_target, prop) {
        if (rbacHolder.roleStandIn && typeof prop === "string" && prop in roleStandIn) {
          return roleStandIn[prop];
        }
        const controller = fallback();
        const value = Reflect.get(controller, prop);
        return typeof value === "function" ? value.bind(controller) : value;
      },
    }
  );
  return { rbac };
});

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSsoEntitlement: async () => "entitled" };
});

// The real SSO controller (the OSS fallback), with the methods a test overrides.
const ssoHolder = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }));
vi.mock("~/services/sso.server", async (importOriginal) => {
  const actual = (await importOriginal()) as { ssoController: object };
  const ssoController = new Proxy(actual.ssoController, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in ssoHolder.overrides) {
        return ssoHolder.overrides[prop];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...actual, ssoController };
});

import { postgresTest } from "@internal/testcontainers";
import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import type { AuditLogActor, AuditLogSource } from "@trigger.dev/plugins";
import { ok } from "neverthrow";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import { noteSessionAuthentication } from "~/services/auditLogs/auditContext.server";
import { runWithHttpContext } from "~/services/httpAsyncStorage.server";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";
import {
  enableAuditRecording,
  inAuditedRequest,
  installAuditLogPlugin,
  uninstallAuditLogPlugin,
} from "./helpers/auditLogPlugin";

vi.setConfig({ testTimeout: 60_000 });

const SYSTEM = {
  actor: { type: "system", id: null },
  source: "system",
} satisfies { actor: AuditLogActor; source: AuditLogSource };

let disableRecording: (() => void) | undefined;

beforeEach(() => {
  rbacHolder.roleStandIn = false;
  rbacHolder.assignments.clear();
  rbacHolder.failNextGetUserRole = false;
  rbacHolder.reads = { getUserRole: 0, allRoles: 0 };
  rbacHolder.allRolesGate = null;
  ssoHolder.overrides = {};
});

afterEach(() => {
  disableRecording?.();
  disableRecording = undefined;
  uninstallAuditLogPlugin();
});

/** For a test that assigns or reads roles, which the open-source fallback doesn't have. */
function useRoleStandIn() {
  rbacHolder.roleStandIn = true;
}

async function startRecording() {
  const { recorded } = installAuditLogPlugin();
  disableRecording = await enableAuditRecording();
  return recorded;
}

type Recorded = Awaited<ReturnType<typeof startRecording>>;

/** Waits for member events still being described and hands them to the plugin. */
async function flushAuditEvents() {
  await auditLogs.flush();
}

async function recordedEvents(recorded: Recorded) {
  await flushAuditEvents();
  return recorded.map((event) => event.input);
}

/** Events from concurrent requests, in a fixed order: by action. */
function byAction<T extends { action: string }>(events: T[]) {
  return [...events].sort((a, b) => a.action.localeCompare(b.action));
}

/** Each event with the actor and source the request context gave it. */
async function recordedWithContext(recorded: Recorded) {
  await flushAuditEvents();
  return recorded.map(({ input, context }) => ({
    input,
    actor: context.actor,
    source: context.source,
  }));
}

/** Runs `fn` as a dashboard request from a signed-in user, the way server.ts and auth do. */
function asDashboardUser<T>(userId: string, request: Request, fn: () => Promise<T>): Promise<T> {
  return runWithHttpContext(
    {
      requestId: "req_test",
      path: new URL(request.url).pathname,
      host: "localhost",
      method: request.method,
      abortController: new AbortController(),
    },
    () => {
      noteSessionAuthentication(request, { userId });
      return fn();
    }
  );
}

function dashboardUser(userId: string) {
  return { actor: { type: "user", id: userId }, source: "dashboard" };
}

function formRequest(path: string, fields: Record<string, string>, headers?: HeadersInit) {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return new Request(`http://localhost:3030${path}`, { method: "POST", body, headers });
}

/** A form POST carrying the session cookie of a signed-in user, as the browser sends it. */
async function signedInFormRequest(userId: string, path: string, fields: Record<string, string>) {
  const session = await getUserSession(new Request("http://localhost:3030/"));
  session.set("user", { userId });
  const cookie = (await commitSession(session)).split(";")[0]!;
  return formRequest(path, fields, { cookie });
}

/** Calls a route action the way server.ts does: inside the request's HTTP context. */
function callRouteAction(
  action: (args: ActionFunctionArgs) => Promise<Response>,
  request: Request,
  params: Record<string, string>
): Promise<Response> {
  return runWithHttpContext(
    {
      requestId: "req_test",
      path: new URL(request.url).pathname,
      host: "localhost",
      method: request.method,
      abortController: new AbortController(),
    },
    () => action({ request, params, context: {} })
  );
}

function suffix() {
  return randomBytes(4).toString("hex");
}

async function seedOrg(prisma: PrismaClient) {
  const id = suffix();
  const admin = await prisma.user.create({
    data: { email: `admin-${id}@test.local`, authenticationMethod: "MAGIC_LINK" },
  });
  const member = await prisma.user.create({
    data: { email: `member-${id}@test.local`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: {
      title: `members-${id}`,
      slug: `members-${id}`,
      isActivated: true,
      members: {
        createMany: {
          data: [
            { userId: admin.id, role: "ADMIN" },
            { userId: member.id, role: "MEMBER" },
          ],
        },
      },
    },
    include: { members: true },
  });
  const adminMember = organization.members.find((m) => m.userId === admin.id)!;
  const regularMember = organization.members.find((m) => m.userId === member.id)!;
  rbacHolder.assignments.set(`${organization.id}:${admin.id}`, rbacHolder.roles.owner);
  rbacHolder.assignments.set(`${organization.id}:${member.id}`, rbacHolder.roles.developer);
  return { organization, admin, member, adminMember, regularMember };
}

async function createUser(prisma: PrismaClient, name: string) {
  return prisma.user.create({
    data: { email: `${name}-${suffix()}@test.local`, authenticationMethod: "MAGIC_LINK" },
  });
}

describe("invite audit events", () => {
  // Catches: an invite created without an event, an event for an email that was already invited
  // (nothing was created), or the invited role recorded as an id instead of its name.
  postgresTest("records member.invited for each invite created", async ({ prisma }) =>
    inAuditedRequest(async () => {
      prismaHolder.client = prisma;
      useRoleStandIn();
      const { inviteMembers } = await import("~/models/member.server");
      const { organization, admin } = await seedOrg(prisma);
      await inviteMembers({
        slug: organization.slug,
        emails: ["first@test.local"],
        userId: admin.id,
      });

      const recorded = await startRecording();
      const { created } = await inviteMembers({
        slug: organization.slug,
        emails: ["first@test.local", "second@test.local"],
        userId: admin.id,
        rbacRoleId: rbacHolder.roles.admin.id,
      });

      expect(created).toHaveLength(1);
      expect(await recordedEvents(recorded)).toEqual([
        {
          category: "members",
          action: "member.invited",
          organizationId: organization.id,
          target: { type: "invite", id: created[0]!.id, name: "second@test.local" },
          changes: { role: "Admin" },
        },
      ]);
    })
  );

  // Catches: a revoke recording nothing, or a revoke of a missing invite recording one.
  postgresTest("records invite.revoked once the invite is deleted", async ({ prisma }) =>
    inAuditedRequest(async () => {
      prismaHolder.client = prisma;
      const { inviteMembers, revokeInvite } = await import("~/models/member.server");
      const { organization, admin } = await seedOrg(prisma);
      const {
        created: [invite],
      } = await inviteMembers({
        slug: organization.slug,
        emails: ["gone@test.local"],
        userId: admin.id,
      });

      const recorded = await startRecording();
      await revokeInvite({ userId: admin.id, orgSlug: organization.slug, inviteId: invite!.id });
      await expect(
        revokeInvite({ userId: admin.id, orgSlug: organization.slug, inviteId: invite!.id })
      ).rejects.toThrow("Invite not found");

      expect(await recordedEvents(recorded)).toEqual([
        {
          category: "members",
          action: "invite.revoked",
          organizationId: organization.id,
          target: { type: "invite", id: invite!.id, name: "gone@test.local" },
        },
      ]);
    })
  );

  // Catches: an accept recording nothing, or a later accept of the consumed invite recording again.
  postgresTest(
    "records invite.accepted once when an accepted invite is accepted again",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        prismaHolder.client = prisma;
        const { acceptInvite, inviteMembers } = await import("~/models/member.server");
        const { organization, admin } = await seedOrg(prisma);
        const joiner = await createUser(prisma, "joiner");
        const {
          created: [invite],
        } = await inviteMembers({
          slug: organization.slug,
          emails: [joiner.email],
          userId: admin.id,
        });

        const recorded = await startRecording();
        await acceptInvite({ user: joiner, inviteId: invite!.id, organizationId: organization.id });
        await expect(
          acceptInvite({ user: joiner, inviteId: invite!.id, organizationId: organization.id })
        ).rejects.toThrow("Invite not found");

        expect(
          await prisma.orgMember.count({
            where: { userId: joiner.id, organizationId: organization.id },
          })
        ).toBe(1);
        expect(await recordedEvents(recorded)).toEqual([
          {
            category: "members",
            action: "invite.accepted",
            organizationId: organization.id,
            target: { type: "invite", id: invite!.id, name: joiner.email },
          },
        ]);
      })
  );

  // Catches: two concurrent accepts of one invite both recording it. Both requests read the invite
  // before either deletes it, so one delete misses (P2025) and must record nothing.
  postgresTest("records invite.accepted once for two concurrent accepts", async ({ prisma }) =>
    inAuditedRequest(async () => {
      prismaHolder.client = prisma;
      const { acceptInvite, inviteMembers } = await import("~/models/member.server");
      const { organization, admin } = await seedOrg(prisma);
      const joiner = await createUser(prisma, "joiner");
      const {
        created: [invite],
      } = await inviteMembers({
        slug: organization.slug,
        emails: [joiner.email],
        userId: admin.id,
      });

      // Holds each invite delete until both requests reach it.
      let deletesStarted = 0;
      let releaseDeletes!: () => void;
      const bothAtDelete = new Promise<void>((resolve) => (releaseDeletes = resolve));
      prismaHolder.client = prisma.$extends({
        query: {
          orgMemberInvite: {
            async delete({ args, query }) {
              if (++deletesStarted === 2) releaseDeletes();
              await Promise.race([bothAtDelete, new Promise((r) => setTimeout(r, 10_000))]);
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;

      const recorded = await startRecording();
      const results = await Promise.allSettled([
        acceptInvite({ user: joiner, inviteId: invite!.id, organizationId: organization.id }),
        acceptInvite({ user: joiner, inviteId: invite!.id, organizationId: organization.id }),
      ]);

      expect(deletesStarted).toBe(2);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(
        await prisma.orgMember.count({
          where: { userId: joiner.id, organizationId: organization.id },
        })
      ).toBe(1);
      expect(await recordedEvents(recorded)).toEqual([
        {
          category: "members",
          action: "invite.accepted",
          organizationId: organization.id,
          target: { type: "invite", id: invite!.id, name: joiner.email },
        },
      ]);
    })
  );
});

describe("invite accepted with a role", () => {
  // Catches: an invite that assigned a role recording invite.accepted without it, so the role
  // change is in no event; or the role recorded as an id instead of its name.
  postgresTest("records the role the invite assigned", async ({ prisma }) =>
    inAuditedRequest(async () => {
      prismaHolder.client = prisma;
      useRoleStandIn();
      const { acceptInvite, inviteMembers } = await import("~/models/member.server");
      const { organization, admin } = await seedOrg(prisma);
      const joiner = await createUser(prisma, "joiner");
      const {
        created: [invite],
      } = await inviteMembers({
        slug: organization.slug,
        emails: [joiner.email],
        userId: admin.id,
        rbacRoleId: rbacHolder.roles.developer.id,
      });

      const recorded = await startRecording();
      await acceptInvite({ user: joiner, inviteId: invite!.id, organizationId: organization.id });

      expect(rbacHolder.assignments.get(`${organization.id}:${joiner.id}`)).toEqual(
        rbacHolder.roles.developer
      );
      expect(await recordedEvents(recorded)).toEqual([
        {
          category: "members",
          action: "invite.accepted",
          organizationId: organization.id,
          target: { type: "invite", id: invite!.id, name: joiner.email },
          changes: { role: "Developer" },
        },
      ]);
    })
  );

  // Catches: a role recorded for an existing member whose role the invite left alone. Per the RBAC
  // plugin's contract, a member with only a legacy OrgMember.role still has a role (the legacy
  // mapping), so the invite's role is not assigned.
  postgresTest("records no role when an existing member keeps theirs", async ({ prisma }) =>
    inAuditedRequest(async () => {
      prismaHolder.client = prisma;
      useRoleStandIn();
      const { acceptInvite, inviteMembers } = await import("~/models/member.server");
      const { organization, admin } = await seedOrg(prisma);
      const joiner = await createUser(prisma, "legacy");
      const {
        created: [invite],
      } = await inviteMembers({
        slug: organization.slug,
        emails: [joiner.email],
        userId: admin.id,
        rbacRoleId: rbacHolder.roles.developer.id,
      });
      // Joined another way (e.g. SSO) after the invite was sent, with a legacy role only.
      await prisma.orgMember.create({
        data: { userId: joiner.id, organizationId: organization.id, role: "MEMBER" },
      });

      const recorded = await startRecording();
      await acceptInvite({ user: joiner, inviteId: invite!.id, organizationId: organization.id });

      expect(rbacHolder.assignments.has(`${organization.id}:${joiner.id}`)).toBe(false);
      expect(await recordedEvents(recorded)).toEqual([
        {
          category: "members",
          action: "invite.accepted",
          organizationId: organization.id,
          target: { type: "invite", id: invite!.id, name: joiner.email },
        },
      ]);
    })
  );
  // Catches: concurrent accepts where the request that consumes the invite isn't the one that
  // created the membership. The creator assigns the invite's role first, so the consumer finds a
  // role already there and assigns nothing. The role must be recorded once, by the creator that
  // assigned it, and invite.accepted once, by the consumer.
  postgresTest("records the role once when a concurrent accept assigned it", async ({ prisma }) =>
    inAuditedRequest(async () => {
      prismaHolder.client = prisma;
      useRoleStandIn();
      const { acceptInvite, inviteMembers } = await import("~/models/member.server");
      const { organization, admin } = await seedOrg(prisma);
      const joiner = await createUser(prisma, "joiner");
      const {
        created: [invite],
      } = await inviteMembers({
        slug: organization.slug,
        emails: [joiner.email],
        userId: admin.id,
        rbacRoleId: rbacHolder.roles.developer.id,
      });

      // Each accept runs labelled, so the client below can tell them apart. Both reach the invite
      // delete with the membership created by one of them. The other deletes the invite first and
      // waits for the creator's accept to finish before it checks the role.
      const acceptLabel = new AsyncLocalStorage<string>();
      const accepts = new Map<string, Promise<unknown>>();
      let creator: string | undefined;
      let deletesStarted = 0;
      let releaseDeletes!: () => void;
      const bothAtDelete = new Promise<void>((resolve) => (releaseDeletes = resolve));
      let consumerDeleted!: () => void;
      const consumerDeletedInvite = new Promise<void>((resolve) => (consumerDeleted = resolve));
      const timeout = () => new Promise((resolve) => setTimeout(resolve, 10_000));
      prismaHolder.client = prisma.$extends({
        query: {
          orgMember: {
            async create({ args, query }) {
              const member = await query(args);
              creator = acceptLabel.getStore();
              return member;
            },
          },
          orgMemberInvite: {
            async delete({ args, query }) {
              if (++deletesStarted === 2) releaseDeletes();
              await Promise.race([bothAtDelete, timeout()]);
              if (acceptLabel.getStore() === creator) {
                await Promise.race([consumerDeletedInvite, timeout()]);
                return query(args);
              }
              const deleted = await query(args);
              consumerDeleted();
              await Promise.race([accepts.get(creator!), timeout()]);
              return deleted;
            },
          },
        },
      }) as unknown as PrismaClient;

      const recorded = await startRecording();
      for (const label of ["first", "second"]) {
        accepts.set(
          label,
          acceptLabel
            .run(label, () =>
              acceptInvite({ user: joiner, inviteId: invite!.id, organizationId: organization.id })
            )
            .catch((error) => error)
        );
      }
      const results = await Promise.all(accepts.values());

      expect(creator).toBeDefined();
      expect(results.filter((result) => result instanceof Error)).toEqual([]);
      expect(rbacHolder.assignments.get(`${organization.id}:${joiner.id}`)).toEqual(
        rbacHolder.roles.developer
      );
      const joinerMember = await prisma.orgMember.findFirstOrThrow({
        where: { userId: joiner.id, organizationId: organization.id },
      });
      expect(byAction(await recordedEvents(recorded))).toEqual([
        {
          category: "members",
          action: "invite.accepted",
          organizationId: organization.id,
          target: { type: "invite", id: invite!.id, name: joiner.email },
        },
        {
          category: "members",
          action: "member.role_changed",
          organizationId: organization.id,
          target: { type: "member", id: joinerMember.id, name: joiner.email },
          changes: { role: { before: "Admin", after: "Developer" } },
        },
      ]);
    })
  );

  // Catches: concurrent accepts where the creator of the membership assigns the invite's role after
  // the other request consumed the invite and checked the role. The consumer sees the membership's
  // legacy role, so its invite.accepted has no role; the creator's invite delete misses, so it must
  // record the role it assigned as member.role_changed. The client below holds the creator between
  // creating the membership and deleting the invite, and starts the consumer once the membership
  // exists.
  postgresTest(
    "records the role when a concurrent accept assigns it after the invite was consumed",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        prismaHolder.client = prisma;
        useRoleStandIn();
        const { acceptInvite, inviteMembers } = await import("~/models/member.server");
        const { organization, admin } = await seedOrg(prisma);
        const joiner = await createUser(prisma, "joiner");
        const {
          created: [invite],
        } = await inviteMembers({
          slug: organization.slug,
          emails: [joiner.email],
          userId: admin.id,
          rbacRoleId: rbacHolder.roles.developer.id,
        });

        const acceptLabel = new AsyncLocalStorage<string>();
        const timeout = () => new Promise((resolve) => setTimeout(resolve, 10_000));
        let membershipCreated!: () => void;
        const creatorCreatedMembership = new Promise<void>(
          (resolve) => (membershipCreated = resolve)
        );
        let releaseCreator!: () => void;
        const creatorReleased = new Promise<void>((resolve) => (releaseCreator = resolve));
        prismaHolder.client = prisma.$extends({
          query: {
            orgMember: {
              async create({ args, query }) {
                const member = await query(args);
                if (acceptLabel.getStore() === "creator") {
                  membershipCreated();
                  await Promise.race([creatorReleased, timeout()]);
                }
                return member;
              },
            },
          },
        }) as unknown as PrismaClient;
        const accept = (label: string) =>
          acceptLabel
            .run(label, () =>
              acceptInvite({ user: joiner, inviteId: invite!.id, organizationId: organization.id })
            )
            .catch((error) => error);

        const recorded = await startRecording();
        const creatorFinished = accept("creator");
        await Promise.race([creatorCreatedMembership, timeout()]);
        const consumerResult = await accept("consumer");
        const roleAfterConsumer = rbacHolder.assignments.get(`${organization.id}:${joiner.id}`);
        releaseCreator();
        const creatorResult = await creatorFinished;

        expect(consumerResult).not.toBeInstanceOf(Error);
        expect(creatorResult).not.toBeInstanceOf(Error);
        expect(roleAfterConsumer).toBeUndefined();
        expect(await prisma.orgMemberInvite.count({ where: { id: invite!.id } })).toBe(0);
        expect(rbacHolder.assignments.get(`${organization.id}:${joiner.id}`)).toEqual(
          rbacHolder.roles.developer
        );
        const joinerMember = await prisma.orgMember.findFirstOrThrow({
          where: { userId: joiner.id, organizationId: organization.id },
        });
        expect(byAction(await recordedEvents(recorded))).toEqual([
          {
            category: "members",
            action: "invite.accepted",
            organizationId: organization.id,
            target: { type: "invite", id: invite!.id, name: joiner.email },
          },
          {
            category: "members",
            action: "member.role_changed",
            organizationId: organization.id,
            target: { type: "member", id: joinerMember.id, name: joiner.email },
            changes: { role: { before: "Admin", after: "Developer" } },
          },
        ]);
      })
  );
});

describe("reads made only for audit events", () => {
  // Catches: a member change reading roles or members only to describe an event while recording
  // is off. The second half is the control: the same counters move once recording is on.
  postgresTest("are skipped while recording is off", async ({ prisma }) =>
    inAuditedRequest(async () => {
      prismaHolder.client = prisma;
      useRoleStandIn();
      const { acceptInvite, inviteMembers } = await import("~/models/member.server");
      const { ensureOrgMember, setOrgMemberRole } = await import("~/models/orgMember.server");
      const { organization, admin, member } = await seedOrg(prisma);
      const joiner = await createUser(prisma, "joiner");
      const ssoJoiner = await createUser(prisma, "sso");
      const { recorded } = installAuditLogPlugin();
      expect(auditLogs.isRecordingEnabled()).toBe(false);

      const roleChange = await setOrgMemberRole({
        userId: member.id,
        organizationId: organization.id,
        roleId: rbacHolder.roles.admin.id,
      });
      const {
        created: [invite],
      } = await inviteMembers({
        slug: organization.slug,
        emails: [joiner.email],
        userId: admin.id,
        rbacRoleId: rbacHolder.roles.developer.id,
      });
      await acceptInvite({ user: joiner, inviteId: invite!.id, organizationId: organization.id });
      const added = await ensureOrgMember({
        userId: ssoJoiner.id,
        organizationId: organization.id,
        roleId: rbacHolder.roles.developer.id,
        source: "sso_jit",
      });
      await flushAuditEvents();

      expect(roleChange).toEqual({ ok: true });
      expect(added.created).toBe(true);
      expect(rbacHolder.assignments.get(`${organization.id}:${member.id}`)).toEqual(
        rbacHolder.roles.admin
      );
      expect(rbacHolder.assignments.get(`${organization.id}:${joiner.id}`)).toEqual(
        rbacHolder.roles.developer
      );
      expect(rbacHolder.reads).toEqual({ getUserRole: 0, allRoles: 0 });
      expect(recorded).toEqual([]);

      disableRecording = await enableAuditRecording();
      await setOrgMemberRole({
        userId: member.id,
        organizationId: organization.id,
        roleId: rbacHolder.roles.developer.id,
      });
      await flushAuditEvents();
      expect(rbacHolder.reads).toEqual({ getUserRole: 1, allRoles: 1 });
      expect(recorded).toHaveLength(1);
    })
  );

  // Catches: a role change waiting for the role names that describe it before returning.
  postgresTest("don't hold up the role change", async ({ prisma }) =>
    inAuditedRequest(async () => {
      prismaHolder.client = prisma;
      useRoleStandIn();
      const { setOrgMemberRole } = await import("~/models/orgMember.server");
      const { organization, member, regularMember } = await seedOrg(prisma);
      let releaseRoleNames!: () => void;
      rbacHolder.allRolesGate = new Promise<void>((resolve) => (releaseRoleNames = resolve));

      const recorded = await startRecording();
      const outcome = await Promise.race([
        setOrgMemberRole({
          userId: member.id,
          organizationId: organization.id,
          roleId: rbacHolder.roles.admin.id,
        }),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000)),
      ]);
      const recordedBeforeRelease = recorded.length;
      releaseRoleNames();

      expect(outcome).toEqual({ ok: true });
      expect(recordedBeforeRelease).toBe(0);
      expect(await recordedEvents(recorded)).toEqual([
        {
          category: "members",
          action: "member.role_changed",
          organizationId: organization.id,
          target: { type: "member", id: regularMember.id, name: member.email },
          changes: { role: { before: "Developer", after: "Admin" } },
        },
      ]);
    })
  );
});

describe("member removal audit events", () => {
  // Catches: a dashboard/API removal recording nothing, or a rejected removal recording one.
  postgresTest("records member.removed after the removal commits", async ({ prisma }) =>
    inAuditedRequest(async () => {
      prismaHolder.client = prisma;
      const { removeTeamMember } = await import("~/models/removeTeamMember.server");
      const { organization, admin, member, adminMember, regularMember } = await seedOrg(prisma);

      const recorded = await startRecording();
      await removeTeamMember(
        { userId: admin.id, slug: organization.slug, memberId: regularMember.id },
        prisma
      );
      // The last member can't be removed.
      await expect(
        removeTeamMember(
          { userId: admin.id, slug: organization.slug, memberId: adminMember.id },
          prisma
        )
      ).rejects.toThrow(/last member/);

      expect(await recordedEvents(recorded)).toEqual([
        {
          category: "members",
          action: "member.removed",
          organizationId: organization.id,
          target: { type: "member", id: regularMember.id, name: member.email },
        },
      ]);
    })
  );
});

describe("role change audit events", () => {
  // Catches: a role change without an event, the before or after role missing or swapped, or an
  // actor override on a change whose actor should come from the request.
  postgresTest("records member.role_changed with the before and after roles", async ({ prisma }) =>
    inAuditedRequest(async () => {
      prismaHolder.client = prisma;
      useRoleStandIn();
      const { setOrgMemberRole } = await import("~/models/orgMember.server");
      const { organization, member, regularMember } = await seedOrg(prisma);

      const recorded = await startRecording();
      const result = await setOrgMemberRole({
        userId: member.id,
        organizationId: organization.id,
        roleId: rbacHolder.roles.admin.id,
      });

      expect(result).toEqual({ ok: true });
      expect(await recordedEvents(recorded)).toEqual([
        {
          category: "members",
          action: "member.role_changed",
          organizationId: organization.id,
          target: { type: "member", id: regularMember.id, name: member.email },
          changes: { role: { before: "Developer", after: "Admin" } },
        },
      ]);
    })
  );

  // Catches: a role change whose event is dropped because the member was removed before the event
  // was described. The client below holds every member read made after the change returns until the
  // removal has committed.
  postgresTest(
    "records member.role_changed when the member is removed right after",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        prismaHolder.client = prisma;
        useRoleStandIn();
        const { setOrgMemberRole } = await import("~/models/orgMember.server");
        const { removeTeamMember } = await import("~/models/removeTeamMember.server");
        const { organization, admin, member, regularMember } = await seedOrg(prisma);

        const removal = new AsyncLocalStorage<true>();
        let holdMemberReads = false;
        let releaseMemberReads!: () => void;
        const removalCommitted = new Promise<void>((resolve) => (releaseMemberReads = resolve));
        prismaHolder.client = prisma.$extends({
          query: {
            orgMember: {
              async findFirst({ args, query }) {
                if (holdMemberReads && !removal.getStore()) {
                  await Promise.race([
                    removalCommitted,
                    new Promise((resolve) => setTimeout(resolve, 10_000)),
                  ]);
                }
                return query(args);
              },
            },
          },
        }) as unknown as PrismaClient;

        const recorded = await startRecording();
        const result = await setOrgMemberRole({
          userId: member.id,
          organizationId: organization.id,
          roleId: rbacHolder.roles.admin.id,
        });
        holdMemberReads = true;
        await removal.run(true, () =>
          removeTeamMember(
            { userId: admin.id, slug: organization.slug, memberId: regularMember.id },
            prisma
          )
        );
        releaseMemberReads();

        expect(result).toEqual({ ok: true });
        expect(await recordedEvents(recorded)).toEqual([
          {
            category: "members",
            action: "member.role_changed",
            organizationId: organization.id,
            target: { type: "member", id: regularMember.id, name: member.email },
            changes: { role: { before: "Developer", after: "Admin" } },
          },
          {
            category: "members",
            action: "member.removed",
            organizationId: organization.id,
            target: { type: "member", id: regularMember.id, name: member.email },
          },
        ]);
      })
  );

  // Catches: an event for a change the plugin refused, for a role the member already had, or for a
  // user who isn't a member (the plugin still writes their role).
  postgresTest(
    "records nothing for a failed or unchanged role, or a non-member",
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      useRoleStandIn();
      const { setOrgMemberRole } = await import("~/models/orgMember.server");
      const { organization, admin, member } = await seedOrg(prisma);
      const outsider = await createUser(prisma, "outsider");

      const recorded = await startRecording();
      const demoteLastOwner = await setOrgMemberRole({
        userId: admin.id,
        organizationId: organization.id,
        roleId: rbacHolder.roles.developer.id,
      });
      const unknownRole = await setOrgMemberRole({
        userId: member.id,
        organizationId: organization.id,
        roleId: "role_missing",
      });
      const sameRole = await setOrgMemberRole({
        userId: member.id,
        organizationId: organization.id,
        roleId: rbacHolder.roles.developer.id,
      });
      const nonMember = await setOrgMemberRole({
        userId: outsider.id,
        organizationId: organization.id,
        roleId: rbacHolder.roles.admin.id,
      });

      expect(demoteLastOwner).toEqual({
        ok: false,
        error: "An organisation must have at least one Owner",
        code: "last_owner",
      });
      expect(unknownRole).toEqual({ ok: false, error: "Role not found" });
      expect(sameRole).toEqual({ ok: true });
      expect(nonMember).toEqual({ ok: true });
      expect(await recordedEvents(recorded)).toEqual([]);
    }
  );

  // Catches: a failed "before" read blocking the role change, or dropping its event.
  postgresTest(
    "changes the role and records it without a before when the pre-read fails",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        prismaHolder.client = prisma;
        useRoleStandIn();
        const { setOrgMemberRole } = await import("~/models/orgMember.server");
        const { organization, member, regularMember } = await seedOrg(prisma);
        rbacHolder.failNextGetUserRole = true;

        const recorded = await startRecording();
        const result = await setOrgMemberRole({
          userId: member.id,
          organizationId: organization.id,
          roleId: rbacHolder.roles.admin.id,
        });

        expect(result).toEqual({ ok: true });
        expect(rbacHolder.assignments.get(`${organization.id}:${member.id}`)).toEqual(
          rbacHolder.roles.admin
        );
        expect(await recordedEvents(recorded)).toEqual([
          {
            category: "members",
            action: "member.role_changed",
            organizationId: organization.id,
            target: { type: "member", id: regularMember.id, name: member.email },
            changes: { role: { before: null, after: "Admin" } },
          },
        ]);
      })
  );

  // Catches: a failed member read before the write blocking the role change, or dropping its event.
  // The client below fails that one read, so the event has to find the member after the write.
  postgresTest(
    "changes the role and records it when the member read before the write fails",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        prismaHolder.client = prisma;
        useRoleStandIn();
        const { setOrgMemberRole } = await import("~/models/orgMember.server");
        const { organization, member, regularMember } = await seedOrg(prisma);
        let failNextMemberRead = false;
        prismaHolder.client = prisma.$extends({
          query: {
            orgMember: {
              async findFirst({ args, query }) {
                if (failNextMemberRead) {
                  failNextMemberRead = false;
                  throw new Error("member read failed");
                }
                return query(args);
              },
            },
          },
        }) as unknown as PrismaClient;

        const recorded = await startRecording();
        failNextMemberRead = true;
        const result = await setOrgMemberRole({
          userId: member.id,
          organizationId: organization.id,
          roleId: rbacHolder.roles.admin.id,
        });

        expect(failNextMemberRead).toBe(false);
        expect(result).toEqual({ ok: true });
        expect(rbacHolder.assignments.get(`${organization.id}:${member.id}`)).toEqual(
          rbacHolder.roles.admin
        );
        expect(await recordedEvents(recorded)).toEqual([
          {
            category: "members",
            action: "member.role_changed",
            organizationId: organization.id,
            target: { type: "member", id: regularMember.id, name: member.email },
            changes: { role: { before: "Developer", after: "Admin" } },
          },
        ]);
      })
  );

  // Catches: a member.role_changed for a membership removed between the member read and the write.
  // The plugin still writes the role for the non-member
  // (https://linear.app/triggerdotdev/issue/TRI-16185). The client below removes the member as soon
  // as the member read before the write returns.
  postgresTest(
    "records nothing for a member removed between the member read and the write",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        prismaHolder.client = prisma;
        useRoleStandIn();
        const { setOrgMemberRole } = await import("~/models/orgMember.server");
        const { removeTeamMember } = await import("~/models/removeTeamMember.server");
        const { organization, admin, member, regularMember } = await seedOrg(prisma);

        const removal = new AsyncLocalStorage<true>();
        let removeAfterNextMemberRead = false;
        prismaHolder.client = prisma.$extends({
          query: {
            orgMember: {
              async findFirst({ args, query }) {
                const found = await query(args);
                if (removeAfterNextMemberRead && !removal.getStore()) {
                  removeAfterNextMemberRead = false;
                  await removal.run(true, () =>
                    removeTeamMember(
                      { userId: admin.id, slug: organization.slug, memberId: regularMember.id },
                      prisma
                    )
                  );
                }
                return found;
              },
            },
          },
        }) as unknown as PrismaClient;

        const recorded = await startRecording();
        removeAfterNextMemberRead = true;
        const result = await setOrgMemberRole({
          userId: member.id,
          organizationId: organization.id,
          roleId: rbacHolder.roles.admin.id,
        });

        expect(removeAfterNextMemberRead).toBe(false);
        expect(result).toEqual({ ok: true });
        expect(
          await prisma.orgMember.count({
            where: { userId: member.id, organizationId: organization.id },
          })
        ).toBe(0);
        expect(rbacHolder.assignments.get(`${organization.id}:${member.id}`)).toEqual(
          rbacHolder.roles.admin
        );
        expect(await recordedEvents(recorded)).toEqual([
          {
            category: "members",
            action: "member.removed",
            organizationId: organization.id,
            target: { type: "member", id: regularMember.id, name: member.email },
          },
        ]);
      })
  );
});

describe("team settings route", () => {
  // Catches: a dashboard role change attributed to anyone but the signed-in admin, or pinned to an
  // actor by the call site instead of the request.
  postgresTest("attributes a role change to the signed-in admin", async ({ prisma }) => {
    prismaHolder.client = prisma;
    useRoleStandIn();
    const { action } = await import("~/routes/_app.orgs.$organizationSlug.settings.team/route");
    const { organization, admin, member, regularMember } = await seedOrg(prisma);

    const recorded = await startRecording();
    const request = await signedInFormRequest(
      admin.id,
      `/orgs/${organization.slug}/settings/team`,
      {
        _formType: "set-role",
        userId: member.id,
        roleId: rbacHolder.roles.admin.id,
      }
    );
    const response = await callRouteAction(action, request, {
      organizationSlug: organization.slug,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await recordedWithContext(recorded)).toEqual([
      {
        input: {
          category: "members",
          action: "member.role_changed",
          organizationId: organization.id,
          target: { type: "member", id: regularMember.id, name: member.email },
          changes: { role: { before: "Developer", after: "Admin" } },
        },
        ...dashboardUser(admin.id),
      },
    ]);
  });

  // Catches: a role set for a user who isn't a member of the org: the plugin would write an orphan
  // role row and the event would have no member to name.
  postgresTest("rejects a role change for a non-member with a 400", async ({ prisma }) => {
    prismaHolder.client = prisma;
    useRoleStandIn();
    const { action } = await import("~/routes/_app.orgs.$organizationSlug.settings.team/route");
    const { organization, admin } = await seedOrg(prisma);
    const outsider = await createUser(prisma, "outsider");

    const recorded = await startRecording();
    const request = await signedInFormRequest(
      admin.id,
      `/orgs/${organization.slug}/settings/team`,
      {
        _formType: "set-role",
        userId: outsider.id,
        roleId: rbacHolder.roles.admin.id,
      }
    );
    const response = await callRouteAction(action, request, {
      organizationSlug: organization.slug,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Not a member of this organization",
    });
    expect(rbacHolder.assignments.has(`${organization.id}:${outsider.id}`)).toBe(false);
    expect(await recordedEvents(recorded)).toEqual([]);
  });
});

describe("dashboard request attribution", () => {
  // Catches: invite, revoke, accept or removal events pinned to an actor by the call site, or missing
  // the user and source the dashboard session gives them.
  postgresTest("attributes member changes to the signed-in user", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const { acceptInvite, inviteMembers, revokeInvite } = await import("~/models/member.server");
    const { removeTeamMember } = await import("~/models/removeTeamMember.server");
    const { organization, admin, member, regularMember } = await seedOrg(prisma);
    const joiner = await createUser(prisma, "joiner");
    const teamPath = `/orgs/${organization.slug}/settings/team`;

    const recorded = await startRecording();
    const { created } = await asDashboardUser(admin.id, formRequest(teamPath, {}), () =>
      inviteMembers({
        slug: organization.slug,
        emails: [joiner.email, "revoked@test.local"],
        userId: admin.id,
      })
    );
    const joinerInvite = created.find((invite) => invite.email === joiner.email)!;
    const revokedInvite = created.find((invite) => invite.email === "revoked@test.local")!;
    await asDashboardUser(admin.id, formRequest(teamPath, {}), () =>
      revokeInvite({ userId: admin.id, orgSlug: organization.slug, inviteId: revokedInvite.id })
    );
    await asDashboardUser(joiner.id, formRequest("/invites", {}), () =>
      acceptInvite({ user: joiner, inviteId: joinerInvite.id, organizationId: organization.id })
    );
    await asDashboardUser(admin.id, formRequest(teamPath, {}), () =>
      removeTeamMember(
        { userId: admin.id, slug: organization.slug, memberId: regularMember.id },
        prisma
      )
    );

    expect(await recordedWithContext(recorded)).toEqual([
      {
        input: {
          category: "members",
          action: "member.invited",
          organizationId: organization.id,
          target: { type: "invite", id: joinerInvite.id, name: joiner.email },
          changes: null,
        },
        ...dashboardUser(admin.id),
      },
      {
        input: {
          category: "members",
          action: "member.invited",
          organizationId: organization.id,
          target: { type: "invite", id: revokedInvite.id, name: "revoked@test.local" },
          changes: null,
        },
        ...dashboardUser(admin.id),
      },
      {
        input: {
          category: "members",
          action: "invite.revoked",
          organizationId: organization.id,
          target: { type: "invite", id: revokedInvite.id, name: "revoked@test.local" },
        },
        ...dashboardUser(admin.id),
      },
      {
        input: {
          category: "members",
          action: "invite.accepted",
          organizationId: organization.id,
          target: { type: "invite", id: joinerInvite.id, name: joiner.email },
        },
        ...dashboardUser(joiner.id),
      },
      {
        input: {
          category: "members",
          action: "member.removed",
          organizationId: organization.id,
          target: { type: "member", id: regularMember.id, name: member.email },
        },
        ...dashboardUser(admin.id),
      },
    ]);
  });
});

describe("member.added audit events", () => {
  // Catches: an SSO just-in-time membership recording nothing, missing its role, or attributed to
  // the system or to nobody (the sign-in request has no session yet).
  postgresTest("records member.added for an SSO just-in-time membership", async ({ prisma }) => {
    prismaHolder.client = prisma;
    useRoleStandIn();
    const { ensureOrgMember } = await import("~/models/orgMember.server");
    const { ssoSignInAttribution } = await import("~/models/memberAudit.server");
    const { organization } = await seedOrg(prisma);
    const joiner = await createUser(prisma, "sso");

    const recorded = await startRecording();
    const result = await ensureOrgMember(
      {
        userId: joiner.id,
        organizationId: organization.id,
        roleId: rbacHolder.roles.developer.id,
        source: "sso_jit",
      },
      ssoSignInAttribution(joiner.id)
    );

    expect(result.created).toBe(true);
    expect(await recordedEvents(recorded)).toEqual([
      {
        category: "members",
        action: "member.added",
        organizationId: organization.id,
        target: { type: "member", id: result.orgMemberId, name: joiner.email },
        changes: { role: "Developer" },
        actor: { type: "user", id: joiner.id },
        source: "dashboard",
      },
    ]);
  });

  // Catches: an event for a membership that already existed, or for one rolled back because its
  // role couldn't be applied; or a made-up role for the legacy placeholder.
  postgresTest("records nothing for an existing or rolled-back membership", async ({ prisma }) => {
    prismaHolder.client = prisma;
    useRoleStandIn();
    const { ensureOrgMember } = await import("~/models/orgMember.server");
    const { organization, member } = await seedOrg(prisma);
    const rolledBack = await createUser(prisma, "rolled-back");
    const placeholder = await createUser(prisma, "placeholder");

    const recorded = await startRecording();
    const existing = await ensureOrgMember(
      {
        userId: member.id,
        organizationId: organization.id,
        roleId: rbacHolder.roles.admin.id,
        source: "sso_jit",
      },
      SYSTEM
    );
    await expect(
      ensureOrgMember(
        {
          userId: rolledBack.id,
          organizationId: organization.id,
          roleId: "role_missing",
          source: "directory_sync",
        },
        SYSTEM
      )
    ).rejects.toThrow(/failed to apply role/);
    const legacy = await ensureOrgMember(
      {
        userId: placeholder.id,
        organizationId: organization.id,
        roleId: null,
        source: "directory_sync",
      },
      SYSTEM
    );

    expect(existing.created).toBe(false);
    expect(
      await prisma.orgMember.count({
        where: { userId: rolledBack.id, organizationId: organization.id },
      })
    ).toBe(0);
    expect(await recordedEvents(recorded)).toEqual([
      {
        category: "members",
        action: "member.added",
        organizationId: organization.id,
        target: { type: "member", id: legacy.orgMemberId, name: placeholder.email },
        changes: null,
        ...SYSTEM,
      },
    ]);
  });
});

describe("SSO sign-in", () => {
  // Catches: a just-in-time membership recorded without the IP and user agent of the sign-in that
  // made it (the request has no session yet, so nothing else notes them).
  postgresTest(
    "gives a just-in-time member.added the request's IP and user agent",
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      useRoleStandIn();
      const { addSsoStrategy } = await import("~/services/ssoAuth.server");
      const { organization } = await seedOrg(prisma);
      const joiner = await createUser(prisma, "sso");
      ssoHolder.overrides = {
        resolveSsoIdentity: async () => ok({ kind: "existing_user_by_idp", userId: joiner.id }),
        attachSsoIdentity: async () => ok(undefined),
        evaluateJit: async () =>
          ok({
            shouldProvision: true,
            organizationId: organization.id,
            roleId: rbacHolder.roles.developer.id,
          }),
      };
      let strategy: any;
      addSsoStrategy({ use: (registered: unknown) => (strategy = registered) } as any);
      const request = new Request("http://localhost:3030/auth/sso/callback?code=c", {
        headers: { "x-forwarded-for": "203.0.113.7", "user-agent": "sso-test-browser" },
      });
      const profile = {
        email: joiner.email,
        firstName: null,
        lastName: null,
        idpSubjectId: "subject_1",
        idpOrgId: "idp_org_1",
        idpConnectionId: "conn_1",
      };

      const recorded = await startRecording();
      const user = await runWithHttpContext(
        {
          requestId: "req_sso",
          path: "/auth/sso/callback",
          host: "localhost",
          method: "GET",
          abortController: new AbortController(),
        },
        () =>
          strategy.authenticate(request, undefined, {
            name: "sso",
            sessionKey: "user",
            sessionErrorKey: "auth:error",
            sessionStrategyKey: "strategy",
            context: { profile, flow: "user_initiated" },
            throwOnError: true,
          })
      );
      await flushAuditEvents();

      expect(user.userId).toBe(joiner.id);
      expect(
        recorded.map(({ input, context }) => ({
          action: input.action,
          actor: context.actor,
          source: context.source,
          endpoint: context.endpoint,
        }))
      ).toEqual([
        {
          action: "member.added",
          actor: { type: "user", id: joiner.id },
          source: "dashboard",
          endpoint: { ip: "203.0.113.7", userAgent: "sso-test-browser" },
        },
      ]);
    }
  );
});

describe("directory sync audit events", () => {
  // Catches: worker changes recorded with no actor or source (the plugin would drop them), or
  // attributed to a user.
  postgresTest("attributes role changes and removals to the system", async ({ prisma }) => {
    prismaHolder.client = prisma;
    useRoleStandIn();
    const { applyDirectorySyncEffects } = await import("~/services/directorySyncEffects.server");
    const { organization, member, regularMember } = await seedOrg(prisma);

    const recorded = await startRecording();
    await applyDirectorySyncEffects(
      [
        {
          kind: "set_role",
          userId: member.id,
          organizationId: organization.id,
          roleId: rbacHolder.roles.admin.id,
        },
        { kind: "deprovision", userId: member.id, organizationId: organization.id },
      ],
      SYSTEM
    );

    expect(
      await prisma.orgMember.count({
        where: { userId: member.id, organizationId: organization.id },
      })
    ).toBe(0);
    expect(await recordedEvents(recorded)).toEqual([
      {
        category: "members",
        action: "member.role_changed",
        organizationId: organization.id,
        target: { type: "member", id: regularMember.id, name: member.email },
        changes: { role: { before: "Developer", after: "Admin" } },
        ...SYSTEM,
      },
      {
        category: "members",
        action: "member.removed",
        organizationId: organization.id,
        target: { type: "member", id: regularMember.id, name: member.email },
        ...SYSTEM,
      },
    ]);
  });

  // Catches: a provisioned member recording nothing, or also recording a role change for the role
  // they were just given; or a refused last-Owner removal recording a removal.
  postgresTest(
    "records member.added for a provisioned member and nothing for a kept last Owner",
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      useRoleStandIn();
      const { applyDirectorySyncEffects } = await import("~/services/directorySyncEffects.server");
      const { organization, admin } = await seedOrg(prisma);
      const email = `directory-${suffix()}@test.local`;

      const recorded = await startRecording();
      await applyDirectorySyncEffects(
        [
          {
            kind: "provision",
            userId: null,
            email,
            firstName: null,
            lastName: null,
            organizationId: organization.id,
            roleId: rbacHolder.roles.developer.id,
            roleAuthoritative: true,
          },
          { kind: "deprovision", userId: admin.id, organizationId: organization.id },
        ],
        SYSTEM
      );

      const provisioned = await prisma.orgMember.findFirstOrThrow({
        where: { organizationId: organization.id, user: { email } },
      });
      expect(await prisma.orgMember.count({ where: { organizationId: organization.id } })).toBe(3);
      expect(await recordedEvents(recorded)).toEqual([
        {
          category: "members",
          action: "member.added",
          organizationId: organization.id,
          target: { type: "member", id: provisioned.id, name: email },
          changes: { role: "Developer" },
          ...SYSTEM,
        },
      ]);
    }
  );

  // Catches: a group remap saved on the SSO settings page attributed to the system instead of the
  // admin who saved it.
  postgresTest("attributes SSO settings page changes to the admin", async ({ prisma }) => {
    prismaHolder.client = prisma;
    useRoleStandIn();
    const { action } = await import("~/routes/_app.orgs.$organizationSlug.settings.sso/route");
    const { organization, admin, member, regularMember } = await seedOrg(prisma);
    ssoHolder.overrides = {
      isUsingPlugin: async () => true,
      setAllowExternalDomainSync: async () => ok(undefined),
      setAllowManualMembership: async () => ok(undefined),
      setDirectoryDefaultRole: async () => ok(undefined),
      setDirectoryGroupRole: async () =>
        ok({
          effects: [
            {
              kind: "set_role",
              userId: member.id,
              organizationId: organization.id,
              roleId: rbacHolder.roles.admin.id,
            },
          ],
        }),
    };

    const recorded = await startRecording();
    const request = await signedInFormRequest(admin.id, `/orgs/${organization.slug}/settings/sso`, {
      action: "save_dsync_config",
      allowExternalDomainSync: "false",
      allowManualMembership: "true",
      directoryDefaultRoleId: "__none__",
      groupRoles: JSON.stringify([{ groupId: "group_1", roleId: rbacHolder.roles.admin.id }]),
    });
    const response = await callRouteAction(action, request, {
      organizationSlug: organization.slug,
    });

    expect(response.status).toBe(302);
    expect(await recordedWithContext(recorded)).toEqual([
      {
        input: {
          category: "members",
          action: "member.role_changed",
          organizationId: organization.id,
          target: { type: "member", id: regularMember.id, name: member.email },
          changes: { role: { before: "Developer", after: "Admin" } },
        },
        ...dashboardUser(admin.id),
      },
    ]);
  });
});
