import { PrismaClient, prisma } from "~/db.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";

export class ProjectPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    slug,
  }: Pick<Project, "slug"> & {
    userId: User["id"];
  }) {
    const project = await this.#prismaClient.project.findFirst({
      select: {
        id: true,
        slug: true,
        name: true,
        organizationId: true,
        createdAt: true,
        updatedAt: true,
        jobs: {
          select: {
            id: true,
            slug: true,
            title: true,
            aliases: {
              select: {
                version: {
                  select: {
                    version: true,
                    eventSpecification: true,
                    properties: true,
                    runs: {
                      select: {
                        createdAt: true,
                        status: true,
                      },
                      take: 1,
                      orderBy: [{ createdAt: "desc" }],
                    },
                    integrations: {
                      select: {
                        key: true,
                        integration: {
                          select: {
                            slug: true,
                            definition: true,
                            setupStatus: true,
                          },
                        },
                      },
                    },
                  },
                },
                environment: {
                  select: {
                    type: true,
                    orgMember: {
                      select: {
                        userId: true,
                      },
                    },
                  },
                },
              },
              where: {
                name: "latest",
              },
            },
            dynamicTriggers: {
              select: {
                type: true,
              },
            },
          },
          where: {
            internal: false,
            deletedAt: null,
          },
          orderBy: [{ title: "asc" }],
        },
        _count: {
          select: {
            sources: {
              where: {
                active: false,
              },
            },
          },
        },
        organization: {
          select: {
            _count: {
              select: {
                integrations: {
                  where: {
                    setupStatus: "MISSING_FIELDS",
                  },
                },
              },
            },
          },
        },
        environments: {
          select: {
            id: true,
            slug: true,
            type: true,
            orgMember: {
              select: {
                userId: true,
              },
            },
            apiKey: true,
          },
        },
      },
      where: { slug, organization: { members: { some: { userId } } } },
    });

    if (!project) {
      return undefined;
    }

    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      organizationId: project.organizationId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      hasInactiveExternalTriggers: project._count.sources > 0,
      hasUnconfiguredIntegrations: project.organization._count.integrations > 0,
      environments: project.environments.map((environment) => ({
        id: environment.id,
        slug: environment.slug,
        type: environment.type,
        apiKey: environment.apiKey,
        userId: environment.orgMember?.userId,
      })),
    };
  }
}
