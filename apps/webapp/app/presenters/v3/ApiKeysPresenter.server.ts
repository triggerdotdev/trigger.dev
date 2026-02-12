import { type RuntimeEnvironment } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";

export class ApiKeysPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    environmentSlug,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    environmentSlug: RuntimeEnvironment["slug"];
  }) {
    const environment = await this.#prismaClient.runtimeEnvironment.findFirst({
      select: {
        id: true,
        apiKey: true,
        type: true,
        slug: true,
        updatedAt: true,
        orgMember: {
          select: {
            userId: true,
          },
        },
        branchName: true,
        parentEnvironment: {
          select: {
            id: true,
            apiKey: true,
          },
        },
        project: {
          select: {
            id: true,
          },
        },
      },
      where: {
        project: {
          slug: projectSlug,
        },
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
        slug: environmentSlug,
        orgMember:
          environmentSlug === "dev"
            ? {
                userId,
              }
            : undefined,
      },
    });

    if (!environment) {
      throw new Error("Environment not found");
    }

    const vercelIntegration =
      await this.#prismaClient.organizationProjectIntegration.findFirst({
        where: {
          projectId: environment.project.id,
          deletedAt: null,
          organizationIntegration: { service: "VERCEL", deletedAt: null },
        },
        select: { id: true },
      });

    return {
      environment: {
        ...environment,
        apiKey: environment?.parentEnvironment?.apiKey ?? environment?.apiKey,
      },
      hasVercelIntegration: vercelIntegration !== null,
    };
  }
}
