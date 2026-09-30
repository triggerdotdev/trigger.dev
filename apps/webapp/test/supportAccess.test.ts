import { $transaction as realTransaction } from "@trigger.dev/database";
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  // The real shared transaction implementation, minus the webapp wrapper's tracing span.
  $transaction: (client: PrismaClient, nameOrFn: unknown, fnOrOptions?: unknown) => {
    const fn = (typeof nameOrFn === "function" ? nameOrFn : fnOrOptions) as Parameters<
      typeof realTransaction
    >[1];
    return realTransaction(client, fn, () => {});
  },
}));

import { SupportAccessService } from "~/services/supportAccess.server";
import { SUPPORT_ACCESS_APPROVAL_DAYS } from "~/utils/supportAccess";

const DAY_MS = 24 * 60 * 60 * 1000;

async function seed(prisma: PrismaClient, mode: "ALLOW" | "REQUIRES_REQUEST" = "REQUIRES_REQUEST") {
  const suffix = Math.random().toString(36).slice(2, 10);
  const staff = await prisma.user.create({
    data: { email: `staff-${suffix}@example.com`, authenticationMethod: "MAGIC_LINK", admin: true },
  });
  const orgAdmin = await prisma.user.create({
    data: { email: `admin-${suffix}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: {
      title: suffix,
      slug: suffix,
      supportAccessMode: mode,
      members: { create: { userId: orgAdmin.id, role: "ADMIN" } },
    },
  });
  return { staff, orgAdmin, organization, service: new SupportAccessService(prisma) };
}

describe("SupportAccessService", () => {
  postgresTest("an approved request is active until it expires", async ({ prisma }) => {
    const { staff, orgAdmin, organization, service } = await seed(prisma);
    const request = (
      await service.createRequest({
        organizationId: organization.id,
        requestedById: staff.id,
        reason: "stuck runs",
      })
    )._unsafeUnwrap();

    const approvedAt = new Date("2026-09-01T00:00:00Z");
    const approved = await service.approveRequest({
      organizationId: organization.id,
      requestId: request.id,
      approvedById: orgAdmin.id,
      now: approvedAt,
    });
    expect(approved._unsafeUnwrap().expiresAt.getTime()).toBe(
      approvedAt.getTime() + SUPPORT_ACCESS_APPROVAL_DAYS * DAY_MS
    );

    const during = await service.getActiveApproval(
      organization.id,
      new Date(approvedAt.getTime() + DAY_MS)
    );
    expect(during._unsafeUnwrap()?.id).toBe(request.id);

    const after = await service.getActiveApproval(
      organization.id,
      new Date(approvedAt.getTime() + (SUPPORT_ACCESS_APPROVAL_DAYS + 1) * DAY_MS)
    );
    expect(after._unsafeUnwrap()).toBeNull();
  });

  postgresTest("pending and cancelled requests are never active", async ({ prisma }) => {
    const { staff, orgAdmin, organization, service } = await seed(prisma);
    const pending = (
      await service.createRequest({
        organizationId: organization.id,
        requestedById: staff.id,
        reason: "a",
      })
    )._unsafeUnwrap();
    const cancelled = (
      await service.createRequest({
        organizationId: organization.id,
        requestedById: staff.id,
        reason: "b",
      })
    )._unsafeUnwrap();
    await service.cancelRequest({
      organizationId: organization.id,
      requestId: cancelled.id,
      cancelledById: orgAdmin.id,
    });

    expect((await service.getActiveApproval(organization.id))._unsafeUnwrap()).toBeNull();

    const approveCancelled = await service.approveRequest({
      organizationId: organization.id,
      requestId: cancelled.id,
      approvedById: orgAdmin.id,
    });
    expect(approveCancelled._unsafeUnwrapErr()).toEqual({ type: "request_not_pending" });

    const stillPending = await prisma.supportAccessRequest.findFirstOrThrow({
      where: { id: pending.id },
    });
    expect(stillPending.status).toBe("PENDING");
  });

  postgresTest("a request needs a reason and an org in request mode", async ({ prisma }) => {
    const { staff, organization, service } = await seed(prisma);
    const blank = await service.createRequest({
      organizationId: organization.id,
      requestedById: staff.id,
      reason: "   ",
    });
    expect(blank._unsafeUnwrapErr()).toEqual({ type: "reason_required" });

    const allowOrg = await seed(prisma, "ALLOW");
    const onAllow = await allowOrg.service.createRequest({
      organizationId: allowOrg.organization.id,
      requestedById: allowOrg.staff.id,
      reason: "x",
    });
    expect(onAllow._unsafeUnwrapErr()).toEqual({ type: "org_allows_access" });
  });

  postgresTest("a request pending for more than 7 days can't be approved", async ({ prisma }) => {
    const { staff, orgAdmin, organization, service } = await seed(prisma);
    const stale = await prisma.supportAccessRequest.create({
      data: {
        organizationId: organization.id,
        requestedById: staff.id,
        reason: "old",
        createdAt: new Date(Date.now() - 8 * DAY_MS),
      },
    });

    const result = await service.approveRequest({
      organizationId: organization.id,
      requestId: stale.id,
      approvedById: orgAdmin.id,
    });
    expect(result._unsafeUnwrapErr()).toEqual({ type: "request_not_pending" });
  });

  postgresTest("a request can't be approved once the org allows access", async ({ prisma }) => {
    const { staff, orgAdmin, organization, service } = await seed(prisma);
    const request = (
      await service.createRequest({
        organizationId: organization.id,
        requestedById: staff.id,
        reason: "x",
      })
    )._unsafeUnwrap();
    await prisma.organization.update({
      where: { id: organization.id },
      data: { supportAccessMode: "ALLOW" },
    });

    const result = await service.approveRequest({
      organizationId: organization.id,
      requestId: request.id,
      approvedById: orgAdmin.id,
    });
    expect(result._unsafeUnwrapErr()).toEqual({ type: "request_not_pending" });
  });

  postgresTest("deleting the staff user keeps their requests", async ({ prisma }) => {
    const { staff, orgAdmin, organization, service } = await seed(prisma);
    const request = (
      await service.createRequest({
        organizationId: organization.id,
        requestedById: staff.id,
        reason: "x",
      })
    )._unsafeUnwrap();
    await service.approveRequest({
      organizationId: organization.id,
      requestId: request.id,
      approvedById: orgAdmin.id,
    });

    await prisma.user.delete({ where: { id: staff.id } });

    const kept = await prisma.supportAccessRequest.findFirstOrThrow({ where: { id: request.id } });
    expect(kept.status).toBe("APPROVED");
    expect(kept.requestedById).toBeNull();
  });

  postgresTest("requests can only be approved from their own org", async ({ prisma }) => {
    const a = await seed(prisma);
    const b = await seed(prisma);
    const request = (
      await a.service.createRequest({
        organizationId: a.organization.id,
        requestedById: a.staff.id,
        reason: "x",
      })
    )._unsafeUnwrap();

    const crossOrg = await b.service.approveRequest({
      organizationId: b.organization.id,
      requestId: request.id,
      approvedById: b.orgAdmin.id,
    });
    expect(crossOrg._unsafeUnwrapErr()).toEqual({ type: "request_not_pending" });
  });

  postgresTest("switching to Allow cancels pending requests only", async ({ prisma }) => {
    const { staff, orgAdmin, organization, service } = await seed(prisma);
    const pending = (
      await service.createRequest({
        organizationId: organization.id,
        requestedById: staff.id,
        reason: "a",
      })
    )._unsafeUnwrap();
    const approved = (
      await service.createRequest({
        organizationId: organization.id,
        requestedById: staff.id,
        reason: "b",
      })
    )._unsafeUnwrap();
    await service.approveRequest({
      organizationId: organization.id,
      requestId: approved.id,
      approvedById: orgAdmin.id,
    });

    const result = await service.setMode({
      organizationId: organization.id,
      mode: "ALLOW",
      updatedById: orgAdmin.id,
    });
    expect(result._unsafeUnwrap()).toEqual({ cancelledPending: 1 });

    const rows = await prisma.supportAccessRequest.findMany({
      where: { organizationId: organization.id },
    });
    expect(rows.find((r) => r.id === pending.id)?.status).toBe("CANCELLED");
    expect(rows.find((r) => r.id === approved.id)?.status).toBe("APPROVED");

    const org = await prisma.organization.findFirstOrThrow({ where: { id: organization.id } });
    expect(org.supportAccessMode).toBe("ALLOW");
    expect(org.supportAccessModeUpdatedById).toBe(orgAdmin.id);
  });
});
