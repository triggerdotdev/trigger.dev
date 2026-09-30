import { $transaction as realTransaction } from "@trigger.dev/database";
import type { PrismaClient, SupportAccessMode } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/services/routeBuilders/dashboardBuilder", () => ({
  dashboardAction: (_options: unknown, handler: unknown) => handler,
  dashboardLoader: (_options: unknown, handler: unknown) => handler,
}));

vi.mock("~/features.server", () => ({
  featuresForRequest: () => ({ isManagedCloud: true }),
}));

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
  $transaction: (client: PrismaClient, nameOrFn: unknown, fnOrOptions?: unknown) => {
    const fn = (typeof nameOrFn === "function" ? nameOrFn : fnOrOptions) as Parameters<
      typeof realTransaction
    >[1];
    return realTransaction(client, fn, () => {});
  },
}));

import { commitImpersonationSession, setImpersonationId } from "~/services/impersonation.server";
import { action } from "~/routes/_app.orgs.$organizationSlug.settings.support-access/route";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeSetFlag } from "~/v3/featureFlags.server";

type Handler = (args: {
  request: Request;
  context: { organizationId?: string };
  user: { id: string };
}) => Promise<Response>;

async function seed(
  prisma: PrismaClient,
  {
    mode = "REQUIRES_REQUEST",
    featureFlags,
  }: { mode?: SupportAccessMode; featureFlags?: object } = {}
) {
  db.client = prisma;
  const suffix = Math.random().toString(36).slice(2, 10);
  const orgAdmin = await prisma.user.create({
    data: { email: `admin-${suffix}@test.local`, authenticationMethod: "MAGIC_LINK" },
  });
  const org = await prisma.organization.create({
    data: {
      title: suffix,
      slug: suffix,
      supportAccessMode: mode,
      featureFlags,
      members: { create: { userId: orgAdmin.id, role: "ADMIN" } },
    },
  });
  return { orgAdmin, org };
}

function intentRequest(slug: string, fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new Request(`http://localhost:3030/orgs/${slug}/settings/support-access`, {
    method: "POST",
    body,
  });
}

function setModeRequest(slug: string, cookie?: string, mode: SupportAccessMode = "ALLOW") {
  const body = new FormData();
  body.set("intent", "setMode");
  body.set("mode", mode);
  return new Request(`http://localhost:3030/orgs/${slug}/settings/support-access`, {
    method: "POST",
    body,
    headers: cookie ? { Cookie: cookie } : {},
  });
}

async function impersonationCookie(userId: string, orgSlug: string) {
  const session = await setImpersonationId(userId, new Request("http://localhost:3030/"), {
    organizationSlugs: [orgSlug],
  });
  return (await commitImpersonationSession(session)).split(";")[0];
}

describe("Support Access settings action", () => {
  postgresTest("an org admin can change the mode", async ({ prisma }) => {
    const { orgAdmin, org } = await seed(prisma);

    await (action as unknown as Handler)({
      request: setModeRequest(org.slug),
      context: { organizationId: org.id },
      user: { id: orgAdmin.id },
    });

    const after = await prisma.organization.findFirstOrThrow({ where: { id: org.id } });
    expect(after.supportAccessMode).toBe("ALLOW");
  });

  postgresTest("an org admin can approve and cancel pending requests", async ({ prisma }) => {
    const { orgAdmin, org } = await seed(prisma);
    const [toApprove, toCancel] = await Promise.all(
      ["approve me", "cancel me"].map((reason) =>
        prisma.supportAccessRequest.create({
          data: { organizationId: org.id, requestedById: orgAdmin.id, reason },
        })
      )
    );
    const run = (fields: Record<string, string>) =>
      (action as unknown as Handler)({
        request: intentRequest(org.slug, fields),
        context: { organizationId: org.id },
        user: { id: orgAdmin.id },
      });

    await run({ intent: "approve", requestId: toApprove.id });
    await run({ intent: "cancel", requestId: toCancel.id });

    const approved = await prisma.supportAccessRequest.findFirstOrThrow({
      where: { id: toApprove.id },
    });
    const cancelled = await prisma.supportAccessRequest.findFirstOrThrow({
      where: { id: toCancel.id },
    });
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedById).toBe(orgAdmin.id);
    expect(approved.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(cancelled.status).toBe("CANCELLED");
  });

  postgresTest("an action can't touch another org's requests", async ({ prisma }) => {
    const mine = await seed(prisma);
    const theirs = await seed(prisma);
    const request = await prisma.supportAccessRequest.create({
      data: { organizationId: theirs.org.id, requestedById: theirs.orgAdmin.id, reason: "x" },
    });

    await (action as unknown as Handler)({
      request: intentRequest(mine.org.slug, { intent: "approve", requestId: request.id }),
      context: { organizationId: mine.org.id },
      user: { id: mine.orgAdmin.id },
    });

    const after = await prisma.supportAccessRequest.findFirstOrThrow({ where: { id: request.id } });
    expect(after.status).toBe("PENDING");
  });

  postgresTest(
    "a Support Access session cannot change the mode, even with a direct POST",
    async ({ prisma }) => {
      const { orgAdmin, org } = await seed(prisma);
      const cookie = await impersonationCookie(orgAdmin.id, org.slug);

      const response = await (action as unknown as Handler)({
        request: setModeRequest(org.slug, cookie),
        context: { organizationId: org.id },
        user: { id: orgAdmin.id },
      });

      expect(await response.json()).toEqual({ ok: false });
      const after = await prisma.organization.findFirstOrThrow({ where: { id: org.id } });
      expect(after.supportAccessMode).toBe("REQUIRES_REQUEST");
    }
  );
});

describe("Support Access settings flag", () => {
  const turnOnRequests = (org: { id: string; slug: string }, userId: string) =>
    (action as unknown as Handler)({
      request: setModeRequest(org.slug, undefined, "REQUIRES_REQUEST"),
      context: { organizationId: org.id },
      user: { id: userId },
    }).then(
      (response) => response,
      (thrown: unknown) => thrown as Response
    );

  postgresTest("is off by default, so Requires request can't be turned on", async ({ prisma }) => {
    const { orgAdmin, org } = await seed(prisma, { mode: "ALLOW" });

    const response = await turnOnRequests(org, orgAdmin.id);

    expect(response.status).toBe(404);
    const after = await prisma.organization.findFirstOrThrow({ where: { id: org.id } });
    expect(after.supportAccessMode).toBe("ALLOW");
  });

  postgresTest("can be turned on for a single org", async ({ prisma }) => {
    const key = FEATURE_FLAG.supportAccessSettingsEnabled;
    const { orgAdmin, org } = await seed(prisma, { mode: "ALLOW", featureFlags: { [key]: true } });
    const other = await seed(prisma, { mode: "ALLOW" });

    await turnOnRequests(org, orgAdmin.id);
    const refused = await turnOnRequests(other.org, other.orgAdmin.id);

    const after = await prisma.organization.findFirstOrThrow({ where: { id: org.id } });
    expect(after.supportAccessMode).toBe("REQUIRES_REQUEST");
    expect(refused.status).toBe(404);
  });

  postgresTest("can be turned on globally, and an org override wins", async ({ prisma }) => {
    const key = FEATURE_FLAG.supportAccessSettingsEnabled;
    const { orgAdmin, org } = await seed(prisma, { mode: "ALLOW" });
    const optedOut = await seed(prisma, { mode: "ALLOW", featureFlags: { [key]: false } });
    await makeSetFlag(prisma)({ key, value: true });

    await turnOnRequests(org, orgAdmin.id);
    const refused = await turnOnRequests(optedOut.org, optedOut.orgAdmin.id);

    const after = await prisma.organization.findFirstOrThrow({ where: { id: org.id } });
    expect(after.supportAccessMode).toBe("REQUIRES_REQUEST");
    expect(refused.status).toBe(404);
  });
});
