import { PrismaClient, prisma } from "~/db.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import type {
  Endpoint,
  EndpointIndex,
  EndpointIndexStatus,
  RuntimeEnvironment,
  RuntimeEnvironmentType,
} from "@trigger.dev/database";
import {
  EndpointIndexError,
  EndpointIndexErrorSchema,
  IndexEndpointStats,
  parseEndpointIndexStats,
} from "@trigger.dev/core";
import { sortEnvironments } from "~/services/environmentSort.server";

export class ApiKeysPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectSlug }: { userId: User["id"]; projectSlug: Project["slug"] }) {
    const environments = await this.#prismaClient.runtimeEnvironment.findMany({
      select: {
        id: true,
        apiKey: true,
        pkApiKey: true,
        type: true,
        slug: true,
        updatedAt: true,
        orgMember: {
          select: {
            userId: true,
          },
        },
        backgroundWorkers: {
          select: {
            version: true,
          },
          take: 1,
          orderBy: {
            version: "desc",
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
      },
    });

    //filter out environments the only development ones belong to the current user
    const filtered = environments.filter((environment) => {
      if (environment.type === "DEVELOPMENT") {
        return environment.orgMember?.userId === userId;
      }
      return true;
    });

    return {
      environments: sortEnvironments(
        filtered.map((environment) => ({
          id: environment.id,
          apiKey: environment.apiKey,
          pkApiKey: environment.pkApiKey,
          type: environment.type,
          slug: environment.slug,
          updatedAt: environment.updatedAt,
          latestVersion: environment.backgroundWorkers.at(0)?.version,
          //todo add environmentVariableCount
          environmentVariableCount: 0,
        }))
      ),
    };
  }
}
