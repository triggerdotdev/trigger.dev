import { redirect } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { SearchParams } from "~/routes/admin._index";
import {
  clearImpersonationId,
  commitImpersonationSession,
  getImpersonationId,
  setImpersonationId,
} from "~/services/impersonation.server";
import { requireUser } from "~/services/session.server";
import { extractClientIp } from "~/utils/extractClientIp.server";

const pageSize = 20;

export async function adminGetUsers(
  userId: string,
  { page, search }: SearchParams,
) {
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
      v2Enabled: true,
      v3Enabled: true,
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

export async function redirectWithImpersonation(request: Request, userId: string, path: string) {
  const user = await requireUser(request);
  if (!user.admin) {
    throw new Error("Unauthorized");
  }

  const xff = request.headers.get("x-forwarded-for");
  const ipAddress = extractClientIp(xff);

  try {
    await prisma.impersonationAuditLog.create({
      data: {
        action: "START",
        adminId: user.id,
        targetId: userId,
        ipAddress,
      },
    });
  } catch (error) {
    logger.error("Failed to create impersonation audit log", { error, adminId: user.id, targetId: userId });
  }

  const session = await setImpersonationId(userId, request);

  return redirect(path, {
    headers: { "Set-Cookie": await commitImpersonationSession(session) },
  });
}

export async function clearImpersonation(request: Request, path: string) {
  const user = await requireUser(request);
  const targetId = await getImpersonationId(request);

  if (targetId) {
    const xff = request.headers.get("x-forwarded-for");
    const ipAddress = extractClientIp(xff);

    try {
      await prisma.impersonationAuditLog.create({
        data: {
          action: "STOP",
          adminId: user.id,
          targetId,
          ipAddress,
        },
      });
    } catch (error) {
      logger.error("Failed to create impersonation audit log", { error, adminId: user.id, targetId });
    }
  }

  const session = await clearImpersonationId(request);

  return redirect(path, {
    headers: {
      "Set-Cookie": await commitImpersonationSession(session),
    },
  });
}
