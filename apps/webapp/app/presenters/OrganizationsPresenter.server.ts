import { PrismaClient, User } from "@trigger.dev/database";
import { prisma } from "~/db.server";

export class OrganizationsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId }: { userId: User["id"] }) {
    const organizations = await this.#prismaClient.organization.findMany({
      where: { members: { some: { userId } } },
      orderBy: { createdAt: "desc" },
      include: {
        projects: {
          orderBy: { name: "asc" },
          include: {
            _count: {
              select: {
                jobs: {
                  where: {
                    internal: false,
                    deletedAt: null,
                  },
                },
                sources: {
                  where: {
                    active: false,
                  },
                },
              },
            },
          },
        },
        _count: {
          select: {
            members: true,
            integrations: {
              where: {
                setupStatus: "MISSING_FIELDS",
              },
            },
          },
        },
      },
    });

    return organizations.map((org) => {
      return {
        id: org.id,
        slug: org.slug,
        title: org.title,
        projects: org.projects.map((project) => ({
          id: project.id,
          slug: project.slug,
          name: project.name,
          jobCount: project._count.jobs,
          hasInactiveExternalTriggers: project._count.sources > 0,
        })),
        hasUnconfiguredIntegrations: org._count.integrations > 0,
        memberCount: org._count.members,
      };
    });
  }
}
