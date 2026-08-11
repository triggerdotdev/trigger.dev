import { redirect } from "@remix-run/server-runtime";
import { $replica, $transaction, prisma, type PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import type { SearchParams } from "~/routes/admin._index";
import {
  clearImpersonationId,
  commitImpersonationSession,
  getImpersonationId,
  setImpersonationId,
} from "~/services/impersonation.server";
import { authenticator } from "~/services/auth.server";
import { getRealUser } from "~/services/session.server";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { impersonationDestinationPath } from "~/utils/pathBuilder";

const pageSize = 20;

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
              title: true,
              slug: true,
              deletedAt: true,
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

  return {
    users,
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

  return {
    organizations,
    page,
    pageCount: Math.ceil(totalOrgs / pageSize),
    filters: {
      search,
    },
  };
}

/**
 * Starts (or switches) impersonation.
 *
 * The admin gate resolves the *real* authenticated user itself. `requireUser` returns the
 * impersonation target while impersonating, so callers that gated on it refused an admin who was
 * already impersonating someone — they had to stop first — and would have attributed the audit row
 * to the target rather than the admin.
 *
 * `verifiedAdmin` exists only so tests can supply an admin without a session cookie. Production
 * callers must not pass it: passing a `requireUser` result is exactly the bug described above.
 */
export async function redirectWithImpersonation(
  request: Request,
  userId: string,
  path: string,
  verifiedAdmin?: { id: string; admin: boolean },
  prismaClient: PrismaClientOrTransaction = prisma
) {
  const admin = verifiedAdmin ?? (await getRealUser(request, prismaClient));
  if (!admin?.admin) {
    throw new Error("Unauthorized");
  }

  const xff = request.headers.get("x-forwarded-for");
  const ipAddress = extractClientIp(xff);
  const previousTargetId = await getImpersonationId(request);

  // Switching straight from one target to another never passes through `clearImpersonation`, so the
  // previous session is closed here, or the trail shows two overlapping STARTs.
  //
  // Both rows are written in one transaction: as separate statements, a failure between them could
  // start an impersonation whose only audit row is the STOP for the previous target — an admin
  // acting as someone with no record of it.
  //
  // `createdAt` is stamped explicitly rather than left to `@default(now())`, because Postgres `now()`
  // is the *transaction* timestamp: inside one transaction both rows would take the same value, and
  // an audit view ordered by that column couldn't tell which came first.
  const startedAt = new Date();
  const closedAt = new Date(startedAt.getTime() - 1);

  try {
    await $transaction(prismaClient, "startImpersonationAudit", async (tx) => {
      if (previousTargetId && previousTargetId !== userId) {
        await tx.impersonationAuditLog.create({
          data: {
            action: "STOP",
            adminId: admin.id,
            targetId: previousTargetId,
            ipAddress,
            createdAt: closedAt,
          },
        });
      }

      await tx.impersonationAuditLog.create({
        data: {
          action: "START",
          adminId: admin.id,
          targetId: userId,
          ipAddress,
          createdAt: startedAt,
        },
      });
    });
  } catch (error) {
    logger.error("Failed to create impersonation audit log", {
      error,
      adminId: admin.id,
      targetId: userId,
      previousTargetId,
    });
  }

  const session = await setImpersonationId(userId, request);

  return redirect(path, {
    headers: { "Set-Cookie": await commitImpersonationSession(session) },
  });
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
  // Test-only, forwarded to `redirectWithImpersonation` — see its docstring.
  verifiedAdmin?: { id: string; admin: boolean },
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
    target.userId,
    impersonationDestinationPath(organizationSlug, path, new URL(request.url).search),
    verifiedAdmin,
    clients.write
  );
}

export async function clearImpersonation(request: Request, path: string) {
  const authUser = await authenticator.isAuthenticated(request);
  const targetId = await getImpersonationId(request);

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

  return redirect(path, {
    headers: {
      "Set-Cookie": await commitImpersonationSession(session),
    },
  });
}
