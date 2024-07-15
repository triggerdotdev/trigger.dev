import { type PrismaClient, prisma } from "~/db.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";

export class HttpEndpointsPresenter {
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
    const httpEndpoints = await this.#prismaClient.triggerHttpEndpoint.findMany({
      select: {
        id: true,
        key: true,
        icon: true,
        title: true,
        updatedAt: true,
        httpEndpointEnvironments: {
          select: {
            id: true,
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
        },
      },
      where: {
        project: {
          slug,
          organization: {
            members: {
              some: {
                userId,
              },
            },
          },
        },
      },
    });

    return httpEndpoints.map((httpEndpoint) => ({
      ...httpEndpoint,
      httpEndpointEnvironments: httpEndpoint.httpEndpointEnvironments.filter(
        (httpEndpointEnvironment) =>
          httpEndpointEnvironment.environment.orgMember === null ||
          httpEndpointEnvironment.environment.orgMember.userId === userId
      ),
    }));
  }
}
