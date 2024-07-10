import { prisma } from "~/db.server";
import { SearchParams } from "~/routes/admin._index";

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

export async function setV3Enabled(userId: string, id: string, v3Enabled: boolean) {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
  });

  if (user?.admin !== true) {
    throw new Error("Unauthorized");
  }

  return prisma.organization.update({
    where: {
      id,
    },
    data: {
      v3Enabled,
    },
  });
}
