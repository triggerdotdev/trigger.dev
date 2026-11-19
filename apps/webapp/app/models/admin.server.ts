import { forcedSupportAccess } from "~/services/accessPolicy.server";
import { redirect } from "@remix-run/server-runtime";
import { prisma, $replica, type PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import type { SearchParams } from "~/routes/admin._index";
import {
  clearImpersonationId,
  commitImpersonationSession,
  getRawImpersonationId,
  getSupportAccessExpiresAt,
  getSupportAccessOrgSlugs,
  getSupportAccessRequestId,
  setImpersonationId,
} from "~/services/impersonation.server";
import { authenticator } from "~/services/auth.server";
import { requireUser } from "~/services/session.server";
import { SupportAccessService } from "~/services/supportAccess.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { recordAdminImpersonationStarted } from "~/services/adminAudit/adminAuditContext.server";
import { impersonationDestinationPath, supportAccessRequestPath } from "~/utils/pathBuilder";
import { env } from "~/env.server";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import type { AuditLogChanges, AuditLogInput } from "@trigger.dev/plugins";

const pageSize = 20;

// 404, not 403, so a disabled instance doesn't advertise the feature.
// Stopping an impersonation is deliberately never gated.
export function requireAdminDashboardEnabled(): void {
  if (!env.ADMIN_DASHBOARD_ENABLED) {
    throw new Response("Not Found", { status: 404 });
  }
}

function activeApprovalSelect() {
  return {
    where: { status: "APPROVED" as const, expiresAt: { gt: new Date() } },
    select: { id: true },
    take: 1,
  };
}

export async function adminGetUsers(userId: string, { page, search }: SearchParams) {
  page = page || 1;

  search = search ? decodeURIComponent(search) : undefined;

  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
  });

  if (user?.admin !== true) {
    throw new Error("Unauthorized");
  }

  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      admin: true,
      createdAt: true,
      displayName: true,
      orgMemberships: {
        select: {
          organization: {
            select: {
              id: true,
              title: true,
              slug: true,
              deletedAt: true,
              supportAccessMode: true,
              supportAccessRequests: activeApprovalSelect(),
            },
          },
        },
      },
    },
    where: search
      ? {
          OR: [
            {
              name: {
                contains: search,
                mode: "insensitive",
              },
            },
            {
              email: {
                contains: search,
                mode: "insensitive",
              },
            },
            {
              orgMemberships: {
                some: {
                  organization: {
                    title: {
                      contains: search,
                      mode: "insensitive",
                    },
                  },
                },
              },
            },
            {
              orgMemberships: {
                some: {
                  organization: {
                    slug: {
                      contains: search,
                      mode: "insensitive",
                    },
                  },
                },
              },
            },
          ],
        }
      : undefined,
    orderBy: {
      createdAt: "desc",
    },
    take: pageSize,
    skip: (page - 1) * pageSize,
  });

  const totalUsers = await prisma.user.count();
  const forced = await forcedSupportAccess(
    users.flatMap((u) => u.orgMemberships.map(({ organization }) => organization.id))
  );

  return {
    users: users.map((u) => ({
      ...u,
      orgMemberships: u.orgMemberships.map(({ organization }) => ({
        organization: { ...organization, supportAccessForced: forced.has(organization.id) },
      })),
    })),
    page,
    pageCount: Math.ceil(totalUsers / pageSize),
    filters: {
      search,
    },
  };
}

export async function adminGetOrganizations(userId: string, { page, search }: SearchParams) {
  page = page || 1;

  search = search ? decodeURIComponent(search) : undefined;

  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
  });

  if (user?.admin !== true) {
    throw new Error("Unauthorized");
  }

  const organizations = await prisma.organization.findMany({
    select: {
      id: true,
      slug: true,
      title: true,
      isActivated: true,
      deletedAt: true,
      supportAccessMode: true,
      supportAccessRequests: activeApprovalSelect(),
      members: {
        select: {
          user: {
            select: {
              email: true,
            },
          },
        },
      },
    },
    where: search
      ? {
          OR: [
            {
              members: {
                some: {
                  user: {
                    name: {
                      contains: search,
                      mode: "insensitive",
                    },
                  },
                },
              },
            },
            {
              members: {
                some: {
                  user: {
                    email: {
                      contains: search,
                      mode: "insensitive",
                    },
                  },
                },
              },
            },
            {
              slug: {
                contains: search,
                mode: "insensitive",
              },
            },
            {
              title: {
                contains: search,
                mode: "insensitive",
              },
            },
            {
              id: {
                contains: search,
                mode: "insensitive",
              },
            },
          ],
        }
      : undefined,
    orderBy: {
      createdAt: "desc",
    },
    take: pageSize,
    skip: (page - 1) * pageSize,
  });

  const totalOrgs = await prisma.organization.count();
  const forced = await forcedSupportAccess(organizations.map((o) => o.id));

  return {
    organizations: organizations.map((o) => ({
      ...o,
      supportAccessForced: forced.has(o.id),
    })),
    page,
    pageCount: Math.ceil(totalOrgs / pageSize),
    filters: {
      search,
    },
  };
}

const SESSION_REFUSED = {
  org_not_found: "That organization doesn't exist or was deleted.",
  not_a_member: "That user isn't a member of the organization.",
  other: "Couldn't start a Support Access session.",
} as const;

export async function redirectWithImpersonation(
  request: Request,
  target: { userId: string; organizationSlug: string; path: string },
  currentUser?: { id: string; admin: boolean },
  prismaClient: PrismaClientOrTransaction = prisma
) {
  requireAdminDashboardEnabled();

  const user = currentUser ?? (await requireUser(request));
  if (!user.admin) {
    throw new Error("Unauthorized");
  }

  const { userId, organizationSlug, path } = target;

  const supportAccess = new SupportAccessService(prismaClient);
  const access = await supportAccess.resolveSessionAccess({ organizationSlug, userId });

  if (access.isErr()) {
    logger.warn("Cannot start Support Access session", {
      organizationSlug,
      targetId: userId,
      reason: access.error.type,
    });
    return redirectWithErrorMessage("/admin", request, SESSION_REFUSED[access.error.type]);
  }

  if (access.value.type === "request_required") {
    return redirect(supportAccessRequestPath(organizationSlug));
  }

  if (access.value.type === "scoped") {
    logger.info("Starting Support Access session", {
      adminId: user.id,
      targetId: userId,
      organizationSlug,
      supportAccessRequestId: access.value.requestId,
    });
  }

  const xff = request.headers.get("x-forwarded-for");
  const ipAddress = extractClientIp(xff);

  try {
    await prismaClient.impersonationAuditLog.create({
      data: {
        action: "START",
        adminId: user.id,
        targetId: userId,
        ipAddress,
      },
    });
  } catch (error) {
    logger.error("Failed to create impersonation audit log", {
      error,
      adminId: user.id,
      targetId: userId,
    });
  }

  void recordAdminImpersonationStarted({
    request,
    adminUserId: user.id,
    targetUserId: userId,
    organizationSlug,
    access: access.value.type,
    supportAccessRequestId: access.value.type === "scoped" ? access.value.requestId : undefined,
  });

  const session = await setImpersonationId(userId, request, {
    organizationSlugs: [organizationSlug],
    expiresAt: access.value.type === "scoped" ? access.value.expiresAt : undefined,
    requestId: access.value.type === "scoped" ? access.value.requestId : undefined,
  });

  const setCookie = await commitImpersonationSession(session);

  // The reason is read only for the event, so not while recording is off.
  if (auditLogs.isRecordingEnabled()) {
    const requestChanges =
      access.value.type === "scoped"
        ? await supportAccessRequestChanges(prismaClient, access.value.requestId)
        : null;
    // Nothing records a session that ends by expiring, so the start says when it will, if that's
    // fixed.
    const expiresAt = getSupportAccessExpiresAt(session);
    recordSupportSessionEvent("support.session_started", {
      organizationId: access.value.organizationId,
      impersonatedUserId: userId,
      staffUserId: user.id,
      changes: expiresAt
        ? { ...requestChanges, expiresAt: expiresAt.toISOString() }
        : requestChanges,
    });
  }

  return redirect(path, {
    headers: { "Set-Cookie": setCookie },
  });
}

/**
 * Customer-facing audit event for a Support Access session. The customer sees "Trigger.dev
 * support"; the staff member is only in `onBehalfOf`, which is never returned to customers.
 */
function recordSupportSessionEvent(
  action: "support.session_started" | "support.session_ended",
  {
    organizationId,
    impersonatedUserId,
    staffUserId,
    changes = null,
  }: {
    organizationId: string;
    impersonatedUserId: string;
    staffUserId: string;
    changes?: AuditLogChanges | null;
  }
) {
  auditLogs.record(
    supportSessionEvent(action, { organizationId, impersonatedUserId, staffUserId, changes })
  );
}

function supportSessionEvent(
  action: "support.session_started" | "support.session_ended",
  {
    organizationId,
    impersonatedUserId,
    staffUserId,
    changes = null,
  }: {
    organizationId: string;
    impersonatedUserId: string;
    staffUserId: string;
    changes?: AuditLogChanges | null;
  }
): AuditLogInput {
  return {
    category: "support",
    action,
    organizationId,
    target: { type: "user", id: impersonatedUserId, name: null },
    changes,
    actor: { type: "support", id: null },
    source: "staff",
    onBehalfOf: { userId: staffUserId },
  };
}

/** Nothing limits a request's reason when it's made, so the event keeps only its start. */
const MAX_SUPPORT_REASON_LENGTH = 500;

// The reason the organization approved. Shown to the customer already, so it's safe to log. With an
// organization, only a request that organization approved counts.
async function supportAccessRequestChanges(
  prismaClient: PrismaClientOrTransaction,
  requestId: string,
  organizationId?: string
): Promise<AuditLogChanges | null> {
  try {
    const request = await prismaClient.supportAccessRequest.findFirst({
      where: { id: requestId, ...(organizationId ? { organizationId } : {}) },
      select: { reason: true },
    });
    return request ? { reason: request.reason.slice(0, MAX_SUPPORT_REASON_LENGTH) } : null;
  } catch (error) {
    logger.error("Failed to read Support Access request for the audit log", {
      error,
      supportAccessRequestId: requestId,
    });
    return null;
  }
}

// One end event per organization the session's scope covered. A session is started for one
// organization, but the cookie holds a list of slugs. Each is resolved to its organization in the
// background, so ending the session doesn't wait for it. A session under an approved request ends
// with that request's reason, in the organization that approved it, as it started.
function recordSupportSessionEndsLater(
  organizationSlugs: string[],
  {
    impersonatedUserId,
    staffUserId,
    supportAccessRequestId,
  }: { impersonatedUserId: string; staffUserId: string; supportAccessRequestId?: string }
) {
  for (const slug of organizationSlugs) {
    auditLogs.recordLater(async () => {
      const organization = await prisma.organization.findFirst({
        where: { slug },
        select: { id: true },
      });
      if (!organization) return null;
      return supportSessionEvent("support.session_ended", {
        organizationId: organization.id,
        impersonatedUserId,
        staffUserId,
        changes: supportAccessRequestId
          ? await supportAccessRequestChanges(prisma, supportAccessRequestId, organization.id)
          : null,
      });
    });
  }
}

type ImpersonationTarget =
  | { success: true; userId: string; organizationName: string }
  | { success: false; reason: "org-not-found" | "no-confirmed-member" };

/**
 * Read-only lookup of who a `/@/orgs/<slug>/…` link would impersonate: the
 * first organization member who has confirmed their basic details. Writes
 * nothing, so it is safe to call while only rendering the consent page.
 */
export async function findImpersonationTarget(
  organizationSlug: string,
  prismaClient: PrismaClientOrTransaction = $replica
): Promise<ImpersonationTarget> {
  const org = await prismaClient.organization.findFirst({
    where: {
      slug: organizationSlug,
      deletedAt: null,
    },
    select: {
      title: true,
      members: {
        select: {
          user: {
            select: {
              id: true,
              confirmedBasicDetails: true,
            },
          },
        },
      },
    },
  });

  if (!org) {
    return { success: false, reason: "org-not-found" };
  }

  const firstValidMember = org.members.find((m) => m.user.confirmedBasicDetails);

  if (!firstValidMember) {
    return { success: false, reason: "no-confirmed-member" };
  }

  return { success: true, userId: firstValidMember.user.id, organizationName: org.title };
}

/**
 * Starts impersonating the organization's first confirmed member and lands on
 * the requested path with the `/@` prefix stripped. Shared by the same-origin
 * loader path and the consent page's POST so there is one implementation.
 *
 * The destination keeps the incoming query string: both entry points are served
 * at the `/@`-prefixed URL, so `request.url` carries the same search the link
 * arrived with (for example the `?span=` a `/@/runs/<id>` link redirects with).
 */
export async function startImpersonation(
  request: Request,
  organizationSlug: string,
  path: string,
  currentUser: { id: string; admin: boolean },
  clients: { read: PrismaClientOrTransaction; write: PrismaClientOrTransaction } = {
    read: $replica,
    write: prisma,
  }
) {
  const target = await findImpersonationTarget(organizationSlug, clients.read);

  if (!target.success) {
    logger.debug("Cannot impersonate organization", { organizationSlug, reason: target.reason });
    return clearImpersonation(request, "/admin");
  }

  return redirectWithImpersonation(
    request,
    {
      userId: target.userId,
      organizationSlug,
      path: impersonationDestinationPath(organizationSlug, path, new URL(request.url).search),
    },
    currentUser,
    clients.write
  );
}

export async function clearImpersonation(request: Request, path: string) {
  const authUser = await authenticator.isAuthenticated(request);
  // Raw read: stops must audit and clear even with ADMIN_DASHBOARD_ENABLED off.
  const targetId = await getRawImpersonationId(request);
  const staffUserId = targetId ? authUser?.userId : undefined;
  // Read from the cookie before it's cleared, only for the end events, so not while recording is off.
  const organizationSlugs =
    staffUserId && auditLogs.isRecordingEnabled()
      ? ((await getSupportAccessOrgSlugs(request)) ?? [])
      : [];
  const supportAccessRequestId =
    staffUserId && auditLogs.isRecordingEnabled()
      ? await getSupportAccessRequestId(request)
      : undefined;

  if (targetId && authUser?.userId) {
    const xff = request.headers.get("x-forwarded-for");
    const ipAddress = extractClientIp(xff);

    try {
      await prisma.impersonationAuditLog.create({
        data: {
          action: "STOP",
          adminId: authUser.userId,
          targetId,
          ipAddress,
        },
      });
    } catch (error) {
      logger.error("Failed to create impersonation audit log", {
        error,
        adminId: authUser.userId,
        targetId,
      });
    }
  }

  const session = await clearImpersonationId(request);
  const setCookie = await commitImpersonationSession(session);

  if (targetId && staffUserId) {
    recordSupportSessionEndsLater(organizationSlugs, {
      impersonatedUserId: targetId,
      staffUserId,
      supportAccessRequestId,
    });
  }

  return redirect(path, {
    headers: {
      "Set-Cookie": setCookie,
    },
  });
}
