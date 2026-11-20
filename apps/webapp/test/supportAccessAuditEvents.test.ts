import { afterEach, beforeEach, describe, expect, vi } from "vitest";

// Points the global client at the fixture's database; nothing else is replaced. `clearImpersonation`
// reads through the global client.
const db = vi.hoisted(() => ({ client: null as any }));
// Whether the admin dashboard is on; a test turns it off here, never in `env`.
const adminDashboard = vi.hoisted(() => ({ enabled: true }));

vi.mock("~/db.server", async () => {
  const { boundedIn } = await import("@trigger.dev/database");
  return {
    get prisma() {
      return db.client;
    },
    get $replica() {
      return db.client;
    },
    boundedIn,
  };
});
// The real environment, with the admin dashboard flag from `adminDashboard` and the recording flag
// from `auditRecordingEnv` (off, as in production).
vi.mock("~/env.server", async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  const { auditRecordingEnv } = await import("./helpers/auditLogPlugin");
  return auditRecordingEnv({
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, property, receiver) =>
        property === "ADMIN_DASHBOARD_ENABLED"
          ? adminDashboard.enabled
          : Reflect.get(target, property, receiver),
    }),
  });
});

import { postgresTest } from "@internal/testcontainers";
import type { AuditLogListedEvent } from "@trigger.dev/plugins";
import { clearImpersonation, redirectWithImpersonation } from "~/models/admin.server";
import { loader as rootLoader } from "~/root";
import { action as viewAsAction } from "~/routes/resources.impersonation_.view-as";
import { loader as supportAccessLoader } from "~/routes/_app.@.orgs.$organizationSlug.$";
import { noteSessionAuthentication } from "~/services/auditLogs/auditContext.server";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import { runWithHttpContext } from "~/services/httpAsyncStorage.server";
import { commitImpersonationSession, setImpersonationId } from "~/services/impersonation.server";
import { commitSession, getSession } from "~/services/sessionStorage.server";
import {
  enableAuditRecording,
  installAuditLogPlugin,
  uninstallAuditLogPlugin,
} from "./helpers/auditLogPlugin";

vi.setConfig({ testTimeout: 60_000 });

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

async function createFixture(
  prisma: any,
  supportAccessMode: "ALLOW" | "REQUIRES_REQUEST" = "ALLOW"
) {
  const staff = await prisma.user.create({
    data: {
      email: `staff-${suffix()}@trigger.test`,
      name: "Staff Person",
      displayName: "Staffy",
      authenticationMethod: "MAGIC_LINK",
      admin: true,
    },
  });
  const customer = await prisma.user.create({
    data: {
      email: `customer-${suffix()}@test.local`,
      authenticationMethod: "MAGIC_LINK",
      confirmedBasicDetails: true,
    },
  });
  // The customer belongs to two organizations; the session is only for `home`.
  const [home, other] = await Promise.all(
    ["home", "other"].map((name) =>
      prisma.organization.create({
        data: {
          title: name,
          slug: `${name}-${suffix()}`,
          supportAccessMode,
          members: { create: [{ userId: customer.id }] },
        },
      })
    )
  );
  return { staff, customer, home, other };
}

async function startSession(
  prisma: any,
  staff: { id: string },
  customer: { id: string },
  organizationSlug: string
) {
  return redirectWithImpersonation(
    new Request("http://localhost:3030/admin", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.7" },
    }),
    { userId: customer.id, organizationSlug, path: `/orgs/${organizationSlug}` },
    { id: staff.id, admin: true },
    prisma
  );
}

/** The fixture's client, with every query it runs kept in `queries`. The queries still run. */
function withQueryLog(prisma: any) {
  const queries: Array<{ model?: string; operation: string; args: any }> = [];
  const client = prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          queries.push({ model, operation, args });
          return query(args);
        },
      },
    },
  });
  return { client, queries };
}

// The reads only the audit events need: the approved request's reason when a session starts, and
// each of the session's organizations, by slug for its id alone, when it stops.
function auditOnlyReads(queries: Array<{ model?: string; operation: string; args: any }>) {
  return queries
    .filter(
      ({ model, operation, args }) =>
        (model === "SupportAccessRequest" && operation === "findFirst" && args?.select?.reason) ||
        (model === "Organization" &&
          operation === "findFirst" &&
          typeof args?.where?.slug === "string" &&
          Object.keys(args?.select ?? {}).join() === "id")
    )
    .map(({ model, operation }) => `${model}.${operation}`);
}

async function createApproval(
  prisma: any,
  {
    organizationId,
    staffId,
    customerId,
    reason,
    expiresAt,
  }: {
    organizationId: string;
    staffId: string;
    customerId: string;
    reason: string;
    expiresAt: Date;
  }
) {
  return prisma.supportAccessRequest.create({
    data: {
      organizationId,
      requestedById: staffId,
      approvedById: customerId,
      approvedAt: new Date(),
      reason,
      status: "APPROVED",
      expiresAt,
    },
  });
}

async function loginCookie(userId: string) {
  const auth = await getSession();
  auth.set("user", { userId });
  return (await commitSession(auth)).split(";")[0];
}

async function staffCookie(staffUserId: string, startResponse: Response) {
  const impersonation = (startResponse.headers.get("set-cookie") ?? "").split(";")[0];
  return `${await loginCookie(staffUserId)}; ${impersonation}`;
}

/** Runs a loader the way Remix does, returning the response it throws or returns. */
async function respond(loader: () => Promise<unknown>): Promise<Response> {
  try {
    const result = await loader();
    if (result instanceof Response) return result;
    throw new Error("The loader returned data, not a response");
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/** Runs `fn` inside an HTTP request, as server.ts does. */
function inRequest<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  return runWithHttpContext(
    {
      requestId,
      path: "/test",
      host: "localhost",
      method: "GET",
      abortController: new AbortController(),
    },
    fn
  );
}

function support(
  action: "support.session_started" | "support.session_ended",
  {
    organizationId,
    customerId,
    staffId,
    changes = null,
  }: { organizationId: string; customerId: string; staffId: string; changes?: object | null }
) {
  return {
    category: "support",
    action,
    organizationId,
    target: { type: "user", id: customerId, name: null },
    changes,
    actor: { type: "support", id: null },
    source: "staff",
    onBehalfOf: { userId: staffId },
  };
}

// The staff member's id, name and email may only appear in `onBehalfOf`, which customers never see.
function expectNoStaffIdentityOutsideOnBehalfOf(
  input: object,
  staff: { id: string; email: string; name: string | null; displayName: string | null }
) {
  const { onBehalfOf: _onBehalfOf, ...customerVisible } = input as Record<string, unknown>;
  const serialized = JSON.stringify(customerVisible);
  for (const value of [staff.id, staff.email, staff.name, staff.displayName]) {
    if (value) expect(serialized).not.toContain(value);
  }
}

describe("Support Access audit events", () => {
  let disableRecording: (() => void) | undefined;
  beforeEach(() => {
    db.client = null;
  });
  afterEach(() => {
    adminDashboard.enabled = true;
    vi.useRealTimers();
    disableRecording?.();
    disableRecording = undefined;
    uninstallAuditLogPlugin();
  });

  postgresTest(
    "starting and stopping a session records both in the session's organization",
    async ({ prisma }) => {
      db.client = prisma;
      const { recorded } = installAuditLogPlugin();
      disableRecording = await enableAuditRecording();
      const { staff, customer, home } = await createFixture(prisma);

      const started = await startSession(prisma, staff, customer, home.slug);
      expect(started.status).toBe(302);
      expect(started.headers.get("location")).toBe(`/orgs/${home.slug}`);
      await auditLogs.flush();

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.input).toEqual({
        category: "support",
        action: "support.session_started",
        organizationId: home.id,
        target: { type: "user", id: customer.id, name: null },
        // Catches: an expiry recorded for a session with no approved request. Its cookie's maxAge
        // restarts on every commit (e.g. the view-as-user toggle), so it has no fixed end.
        changes: null,
        actor: { type: "support", id: null },
        source: "staff",
        onBehalfOf: { userId: staff.id },
      });

      const response = await clearImpersonation(
        new Request("http://localhost:3030/@", {
          headers: { Cookie: await staffCookie(staff.id, started) },
        }),
        "/admin"
      );
      expect(response.headers.get("location")).toBe("/admin");
      await auditLogs.flush();

      expect(recorded).toHaveLength(2);
      expect(recorded[1]!.input).toEqual({
        category: "support",
        action: "support.session_ended",
        organizationId: home.id,
        target: { type: "user", id: customer.id, name: null },
        changes: null,
        actor: { type: "support", id: null },
        source: "staff",
        onBehalfOf: { userId: staff.id },
      });

      for (const { input } of recorded) {
        expectNoStaffIdentityOutsideOnBehalfOf(input, staff);
      }

      // The existing staff-only record is still written.
      const impersonationLogs = await prisma.impersonationAuditLog.findMany({
        where: { adminId: staff.id },
        orderBy: { createdAt: "asc" },
      });
      expect(impersonationLogs.map((log: { action: string }) => log.action)).toEqual([
        "START",
        "STOP",
      ]);
    }
  );

  postgresTest(
    "a session from an approved request records the request's reason, cut to 500 characters, and its expiry",
    async ({ prisma }) => {
      db.client = prisma;
      const { recorded } = installAuditLogPlugin();
      disableRecording = await enableAuditRecording();
      const { staff, customer, home, other } = await createFixture(prisma, "REQUIRES_REQUEST");
      const longReason = `Ticket 4822: ${"r".repeat(600)}`;
      const approvals = await Promise.all(
        [
          { organizationId: home.id, reason: "Ticket 4821: runs stuck in queue" },
          { organizationId: other.id, reason: longReason },
        ].map(({ organizationId, reason }) =>
          prisma.supportAccessRequest.create({
            data: {
              organizationId,
              requestedById: staff.id,
              approvedById: customer.id,
              approvedAt: new Date(),
              reason,
              status: "APPROVED",
              expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            },
          })
        )
      );

      const started = await startSession(prisma, staff, customer, home.slug);
      expect(started.headers.get("location")).toBe(`/orgs/${home.slug}`);
      const startedOther = await startSession(prisma, staff, customer, other.slug);
      expect(startedOther.headers.get("location")).toBe(`/orgs/${other.slug}`);
      await auditLogs.flush();

      expect(recorded.map(({ input }) => input)).toEqual([
        support("support.session_started", {
          organizationId: home.id,
          customerId: customer.id,
          staffId: staff.id,
          changes: {
            reason: "Ticket 4821: runs stuck in queue",
            expiresAt: approvals[0]!.expiresAt.toISOString(),
          },
        }),
        support("support.session_started", {
          organizationId: other.id,
          customerId: customer.id,
          staffId: staff.id,
          changes: {
            reason: longReason.slice(0, 500),
            expiresAt: approvals[1]!.expiresAt.toISOString(),
          },
        }),
      ]);
      expect((recorded[1]!.input.changes as { reason: string }).reason).toHaveLength(500);

      // Catches: an end that doesn't say why, or says another organization's why.
      const stop = async (startResponse: Response) =>
        clearImpersonation(
          new Request("http://localhost:3030/@", {
            headers: { Cookie: await staffCookie(staff.id, startResponse) },
          }),
          "/admin"
        );
      await stop(started);
      await stop(startedOther);
      await auditLogs.flush();

      expect(recorded.slice(2).map(({ input }) => input)).toEqual([
        support("support.session_ended", {
          organizationId: home.id,
          customerId: customer.id,
          staffId: staff.id,
          changes: { reason: "Ticket 4821: runs stuck in queue" },
        }),
        support("support.session_ended", {
          organizationId: other.id,
          customerId: customer.id,
          staffId: staff.id,
          changes: { reason: longReason.slice(0, 500) },
        }),
      ]);
      for (const { input } of recorded) {
        for (const approval of approvals) {
          expect(JSON.stringify(input)).not.toContain(approval.id);
        }
        expectNoStaffIdentityOutsideOnBehalfOf(input, staff);
      }
    }
  );

  // Catches: a reason one organization gave shown in another organization's log. A session cookie
  // can name several organizations; the request belongs to one of them.
  postgresTest(
    "a session's end carries its reason only in the organization that approved it",
    async ({ prisma }) => {
      db.client = prisma;
      const { recorded } = installAuditLogPlugin();
      disableRecording = await enableAuditRecording();
      const { staff, customer, home, other } = await createFixture(prisma, "REQUIRES_REQUEST");
      const approval = await prisma.supportAccessRequest.create({
        data: {
          organizationId: home.id,
          requestedById: staff.id,
          approvedById: customer.id,
          approvedAt: new Date(),
          reason: "Ticket 4824",
          status: "APPROVED",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const session = await setImpersonationId(customer.id, new Request("http://localhost:3030/"), {
        organizationSlugs: [home.slug, other.slug],
        requestId: approval.id,
      });
      const impersonation = (await commitImpersonationSession(session)).split(";")[0];

      await clearImpersonation(
        new Request("http://localhost:3030/@", {
          headers: { Cookie: `${await loginCookie(staff.id)}; ${impersonation}` },
        }),
        "/admin"
      );
      await auditLogs.flush();

      const ends = recorded.map(({ input }) => [input.organizationId, input.changes]);
      expect(ends).toEqual(
        expect.arrayContaining([
          [home.id, { reason: "Ticket 4824" }],
          [other.id, null],
        ])
      );
      expect(ends).toHaveLength(2);
    }
  );

  postgresTest(
    "a session whose request is gone by its end still ends, without a reason",
    async ({ prisma }) => {
      db.client = prisma;
      const { recorded } = installAuditLogPlugin();
      disableRecording = await enableAuditRecording();
      const { staff, customer, home } = await createFixture(prisma, "REQUIRES_REQUEST");
      const approval = await prisma.supportAccessRequest.create({
        data: {
          organizationId: home.id,
          requestedById: staff.id,
          approvedById: customer.id,
          approvedAt: new Date(),
          reason: "Ticket 4823",
          status: "APPROVED",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const started = await startSession(prisma, staff, customer, home.slug);
      await prisma.supportAccessRequest.delete({ where: { id: approval.id } });
      const response = await clearImpersonation(
        new Request("http://localhost:3030/@", {
          headers: { Cookie: await staffCookie(staff.id, started) },
        }),
        "/admin"
      );
      expect(response.headers.get("location")).toBe("/admin");
      await auditLogs.flush();

      expect(recorded.map(({ input }) => input.action)).toEqual([
        "support.session_started",
        "support.session_ended",
      ]);
      expect(recorded[1]!.input.changes).toBeNull();
    }
  );

  postgresTest("a refused start records nothing", async ({ prisma }) => {
    db.client = prisma;
    const { recorded } = installAuditLogPlugin();
    disableRecording = await enableAuditRecording();
    const { staff, customer, home } = await createFixture(prisma, "REQUIRES_REQUEST");
    const outsider = await prisma.user.create({
      data: { email: `outsider-${suffix()}@test.local`, authenticationMethod: "MAGIC_LINK" },
    });

    // No approved request: sent to the request page.
    const requestRequired = await startSession(prisma, staff, customer, home.slug);
    expect(requestRequired.headers.get("location")).toContain(home.slug);
    expect(requestRequired.headers.get("set-cookie")).toBeNull();

    // Not a member, and an unknown organization: sent back to the admin panel.
    const notAMember = await startSession(prisma, staff, outsider, home.slug);
    expect(notAMember.headers.get("location")).toBe("/admin");
    const unknownOrg = await startSession(prisma, staff, customer, `missing-${suffix()}`);
    expect(unknownOrg.headers.get("location")).toBe("/admin");

    await auditLogs.flush();
    expect(recorded).toEqual([]);
  });

  postgresTest("stopping with no session records nothing", async ({ prisma }) => {
    db.client = prisma;
    const { recorded } = installAuditLogPlugin();
    disableRecording = await enableAuditRecording();
    const { staff } = await createFixture(prisma);

    const auth = await getSession();
    auth.set("user", { userId: staff.id });
    const login = (await commitSession(auth)).split(";")[0];
    await clearImpersonation(
      new Request("http://localhost:3030/@", { headers: { Cookie: login } }),
      "/admin"
    );
    await auditLogs.flush();

    expect(recorded).toEqual([]);
  });

  postgresTest(
    "switching organizations through /@/orgs ends the current session, then starts the next",
    async ({ prisma }) => {
      db.client = prisma;
      const { recorded } = installAuditLogPlugin();
      disableRecording = await enableAuditRecording();
      const { staff, customer, home, other } = await createFixture(prisma);
      const login = await loginCookie(staff.id);

      // A same-origin navigation, as from the admin panel.
      const visit = (organizationSlug: string, cookie: string) =>
        respond(() =>
          supportAccessLoader({
            request: new Request(`http://localhost:3030/@/orgs/${organizationSlug}/`, {
              headers: { Cookie: cookie, "sec-fetch-site": "same-origin" },
            }),
            params: { organizationSlug, "*": "" },
            context: {},
          })
        );
      const impersonationCookie = (response: Response) =>
        (response.headers.get("set-cookie") ?? "").split(";")[0];

      const startedHome = await visit(home.slug, login);
      expect(startedHome.headers.get("location")).toBe(`/orgs/${home.slug}/`);

      // Still in a session for `home`: the loader ends it and comes back to the same URL.
      const switched = await visit(other.slug, `${login}; ${impersonationCookie(startedHome)}`);
      expect(switched.headers.get("location")).toBe(`/@/orgs/${other.slug}/`);

      const startedOther = await visit(other.slug, `${login}; ${impersonationCookie(switched)}`);
      expect(startedOther.headers.get("location")).toBe(`/orgs/${other.slug}/`);
      await auditLogs.flush();

      const ids = { customerId: customer.id, staffId: staff.id };
      expect(recorded.map(({ input }) => input)).toEqual([
        support("support.session_started", { organizationId: home.id, ...ids, changes: null }),
        support("support.session_ended", { organizationId: home.id, ...ids }),
        support("support.session_started", {
          organizationId: other.id,
          ...ids,
          changes: null,
        }),
      ]);
    }
  );

  postgresTest(
    "the root loader ends a session it finds while the admin dashboard is off",
    async ({ prisma }) => {
      db.client = prisma;
      const { recorded } = installAuditLogPlugin();
      disableRecording = await enableAuditRecording();
      const { staff, customer, home } = await createFixture(prisma);

      const started = await startSession(prisma, staff, customer, home.slug);
      const cookie = await staffCookie(staff.id, started);
      adminDashboard.enabled = false;

      const response = await respond(() =>
        rootLoader({
          request: new Request(`http://localhost:3030/orgs/${home.slug}?tab=runs`, {
            headers: { Cookie: cookie },
          }),
          params: {},
          context: {},
        })
      );
      expect(response.headers.get("location")).toBe(`/orgs/${home.slug}?tab=runs`);
      await auditLogs.flush();

      const ids = { customerId: customer.id, staffId: staff.id };
      expect(recorded.map(({ input }) => input)).toEqual([
        support("support.session_started", { organizationId: home.id, ...ids, changes: null }),
        support("support.session_ended", { organizationId: home.id, ...ids }),
      ]);
    }
  );

  postgresTest(
    "inside a request, the support actor replaces the staff member's session",
    async ({ prisma }) => {
      db.client = prisma;
      const { recorded } = installAuditLogPlugin();
      disableRecording = await enableAuditRecording();
      const { staff, customer, home } = await createFixture(prisma);
      const staffRequest = (cookie?: string) =>
        new Request("http://localhost:3030/@", {
          headers: {
            "x-forwarded-for": "203.0.113.7",
            "user-agent": "staff-browser",
            ...(cookie ? { Cookie: cookie } : {}),
          },
        });

      const started = await inRequest("req_start", async () => {
        noteSessionAuthentication(staffRequest(), { userId: staff.id });
        return startSession(prisma, staff, customer, home.slug);
      });
      const cookie = await staffCookie(staff.id, started);
      await inRequest("req_stop", async () => {
        noteSessionAuthentication(staffRequest(cookie), { userId: staff.id });
        return clearImpersonation(staffRequest(cookie), "/admin");
      });
      await auditLogs.flush();

      const ids = { customerId: customer.id, staffId: staff.id };
      // The request says the staff member acted from the dashboard; the input's actor, source and
      // on-behalf-of user override it. The endpoint is the staff member's, stored but never listed.
      const staffContext = (requestId: string) => ({
        occurredAt: expect.any(Date),
        actor: { type: "user", id: staff.id },
        credential: null,
        onBehalfOf: null,
        source: "dashboard",
        endpoint: { ip: "203.0.113.7", userAgent: "staff-browser" },
        origin: null,
        requestId,
      });
      expect(recorded).toEqual([
        {
          input: support("support.session_started", {
            organizationId: home.id,
            ...ids,
            changes: null,
          }),
          context: staffContext("req_start"),
        },
        {
          input: support("support.session_ended", { organizationId: home.id, ...ids }),
          context: staffContext("req_stop"),
        },
      ]);

      // Listed as the plugin would return it: the staff member's endpoint is hidden.
      const { input, context } = recorded[0]!;
      const stored = {
        id: "evt_1",
        category: input.category,
        action: input.action,
        occurredAt: context.occurredAt,
        organizationId: input.organizationId,
        projectId: null,
        environmentId: null,
        environmentType: null,
        target: input.target,
        actor: input.actor ?? context.actor,
        credential: null,
        onBehalfOf: input.onBehalfOf ?? context.onBehalfOf,
        source: input.source ?? context.source,
        endpoint: context.endpoint,
        origin: null,
        requestId: context.requestId,
        changes: null,
      } as unknown as AuditLogListedEvent;
      const controller = await (globalThis as any).__trigger_singletons.auditLogController;
      controller.listEvents = async () => ({ events: [stored], nextCursor: null });

      const page = await auditLogs.listEvents({
        organizationId: home.id,
        from: new Date(0),
        to: new Date(),
        limit: 50,
      });
      expect(page).toEqual({
        events: [
          {
            id: "evt_1",
            category: "support",
            action: "support.session_started",
            occurredAt: context.occurredAt,
            organizationId: home.id,
            projectId: null,
            environmentId: null,
            environmentType: null,
            target: { type: "user", id: customer.id, name: null },
            actor: { type: "support", id: null },
            credential: null,
            source: "staff",
            endpoint: null,
            origin: null,
            requestId: "req_start",
            changes: null,
          },
        ],
        nextCursor: null,
      });
    }
  );
  postgresTest(
    "with recording off, starting and stopping a session reads nothing only the events need",
    async ({ prisma }) => {
      const { client, queries } = withQueryLog(prisma);
      db.client = client;
      installAuditLogPlugin();
      const { staff, customer, home } = await createFixture(prisma, "REQUIRES_REQUEST");
      await createApproval(prisma, {
        organizationId: home.id,
        staffId: staff.id,
        customerId: customer.id,
        reason: "Ticket 4823",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      const startAndStop = async () => {
        const started = await startSession(client, staff, customer, home.slug);
        expect(started.headers.get("location")).toBe(`/orgs/${home.slug}`);
        await clearImpersonation(
          new Request("http://localhost:3030/@", {
            headers: { Cookie: await staffCookie(staff.id, started) },
          }),
          "/admin"
        );
      };

      // Catches: the approved request's reason, or the session's organizations, read on every
      // start or stop although no event is recorded.
      await startAndStop();
      await auditLogs.flush();
      expect(auditOnlyReads(queries)).toEqual([]);

      // Control: with recording on, the same calls make these reads, so the filter above sees them.
      // The organization, and the request's reason for the end, are read in the background, after
      // the stop returns.
      queries.length = 0;
      disableRecording = await enableAuditRecording();
      await startAndStop();
      await auditLogs.flush();
      expect(auditOnlyReads(queries)).toEqual([
        "SupportAccessRequest.findFirst",
        "Organization.findFirst",
        "SupportAccessRequest.findFirst",
      ]);
    }
  );

  postgresTest(
    "the recorded expiry is the one the view-as-user toggle keeps",
    async ({ prisma }) => {
      db.client = prisma;
      const { recorded } = installAuditLogPlugin();
      disableRecording = await enableAuditRecording();
      const startedAt = new Date("2026-11-13T09:30:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"], now: startedAt });
      const { staff, customer, home, other } = await createFixture(prisma, "REQUIRES_REQUEST");
      const approval = await createApproval(prisma, {
        organizationId: home.id,
        staffId: staff.id,
        customerId: customer.id,
        reason: "Ticket 4824",
        expiresAt: new Date(startedAt.getTime() + 60 * 60 * 1000),
      });
      await prisma.organization.update({
        where: { id: other.id },
        data: { supportAccessMode: "ALLOW" },
      });

      const scoped = await startSession(prisma, staff, customer, home.slug);
      const allowed = await startSession(prisma, staff, customer, other.slug);
      await auditLogs.flush();
      expect(recorded.map(({ input }) => input.changes)).toEqual([
        { reason: "Ticket 4824", expiresAt: approval.expiresAt.toISOString() },
        null,
      ]);

      // Half an hour later, staff turn on "View as user", which commits the cookie again.
      const toggledAt = new Date(startedAt.getTime() + 30 * 60 * 1000);
      vi.setSystemTime(toggledAt);
      const cookieExpiry = async (started: Response) => {
        const toggled = await viewAsAction({
          request: new Request("http://localhost:3030/resources/impersonation/view-as", {
            method: "POST",
            headers: {
              Cookie: await staffCookie(staff.id, started),
              "Content-Type": "application/x-www-form-urlencoded",
              "sec-fetch-site": "same-origin",
            },
            body: new URLSearchParams({ viewAsUser: "true", redirectTo: "/" }),
          }),
          params: {},
          context: {},
        });
        const maxAge = /Max-Age=(\d+)/.exec(toggled.headers.get("set-cookie") ?? "")?.[1];
        expect(maxAge).toBeDefined();
        return new Date(toggledAt.getTime() + Number(maxAge) * 1000);
      };

      // Catches: a recorded expiry the cookie no longer keeps after the toggle.
      expect((await cookieExpiry(scoped)).toISOString()).toBe(approval.expiresAt.toISOString());
      // Without an approved request the toggle restarts the 24 hours, so no end was recorded.
      expect((await cookieExpiry(allowed)).toISOString()).toBe(
        new Date(toggledAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
      );
    }
  );
});
