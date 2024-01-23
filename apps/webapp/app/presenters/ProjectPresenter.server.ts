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
    id,
  }: Pick<Project, "id"> & {
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
        _count: {
          select: {
            sources: {
              where: {
                active: false,
              },
            },
            jobs: {
              where: {
                internal: false,
                deletedAt: null,
              },
            },
            httpEndpoints: true,
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
      where: { id, organization: { members: { some: { userId } } } },
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
      jobCount: project._count.jobs,
      httpEndpointCount: project._count.httpEndpoints,
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
