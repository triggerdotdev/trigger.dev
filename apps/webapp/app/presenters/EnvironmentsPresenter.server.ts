import { PrismaClient, prisma } from "~/db.server";
import {
  IndexEndpointStats,
  parseEndpointIndexStats,
} from "~/models/indexEndpoint.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";

type Client = {
  slug: string;
  endpoints: {
    DEVELOPMENT: ClientEndpoint;
    STAGING: ClientEndpoint;
    PRODUCTION: ClientEndpoint;
  };
};

type ClientEndpoint =
  | {
      state: "unconfigured";
    }
  | {
      state: "configured";
      id: string;
      slug: string;
      url: string;
      indexWebhookPath: string;
      latestIndex?: {
        source: string;
        updatedAt: Date;
        stats: IndexEndpointStats;
      };
    };

export class EnvironmentsPresenter {
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
    const environments = await this.#prismaClient.runtimeEnvironment.findMany({
      select: {
        id: true,
        apiKey: true,
        type: true,
        slug: true,
        orgMember: {
          select: {
            userId: true,
          },
        },
        endpoints: {
          select: {
            id: true,
            slug: true,
            url: true,
            indexingHookIdentifier: true,
            indexings: {
              select: {
                source: true,
                updatedAt: true,
                stats: true,
              },
              take: 1,
              orderBy: {
                updatedAt: "desc",
              },
            },
          },
        },
      },
      where: {
        project: {
          slug,
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

    //build up list of clients for display, with endpoints by type
    const clients: Client[] = [];
    for (const environment of filtered) {
      environment.endpoints.forEach((endpoint) => {
        let client = clients.find((client) => client.slug === endpoint.slug);
        if (!client) {
          client = {
            slug: endpoint.slug,
            endpoints: {
              DEVELOPMENT: { state: "unconfigured" },
              STAGING: { state: "unconfigured" },
              PRODUCTION: { state: "unconfigured" },
            },
          };
        }

        if (environment.type === "PREVIEW") {
          console.error("PREVIEW environments are not supported yet");
          return;
        }

        const latestIndex = endpoint.indexings[0];

        client.endpoints[environment.type] = {
          state: "configured",
          id: endpoint.id,
          slug: endpoint.slug,
          url: endpoint.url,
          indexWebhookPath: `/api/v1/endpoints/${environment.id}/${endpoint.slug}/index/${endpoint.indexingHookIdentifier}`,
          latestIndex: latestIndex
            ? {
                source: latestIndex.source,
                updatedAt: latestIndex.updatedAt,
                stats: parseEndpointIndexStats(latestIndex.stats),
              }
            : undefined,
        };
      });
    }

    return {
      environments: filtered.map((environment) => ({
        id: environment.id,
        apiKey: environment.apiKey,
        type: environment.type,
        slug: environment.slug,
      })),
      clients,
    };
  }
}
