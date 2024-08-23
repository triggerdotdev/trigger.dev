import { PrismaClient, prisma } from "~/db.server";
import { Project } from "~/models/project.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { User } from "~/models/user.server";
import { sortEnvironments } from "~/utils/environmentSort";

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
        deletedAt: true,
        version: true,
        externalRef: true,
        environments: {
          select: {
            id: true,
            slug: true,
            type: true,
            orgMember: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    displayName: true,
                  },
                },
              },
            },
            apiKey: true,
          },
        },
      },
      where: { id, deletedAt: null, organization: { members: { some: { userId } } } },
    });

    if (!project) {
      return undefined;
    }

    return {
      id: project.id,
      slug: project.slug,
      ref: project.externalRef,
      name: project.name,
      organizationId: project.organizationId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      deletedAt: project.deletedAt,
      version: project.version,
      environments: sortEnvironments(
        project.environments.map((environment) => ({
          ...displayableEnvironment(environment, userId),
          userId: environment.orgMember?.user.id,
        }))
      ),
    };
  }
}
