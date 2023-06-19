import { PrismaClient, prisma } from "~/db.server";
import {
  IndexEndpointStats,
  parseEndpointIndexStats,
} from "~/models/indexEndpoint.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import {
  Endpoint,
  EndpointIndex,
  RuntimeEnvironment,
  RuntimeEnvironmentType,
} from "../../../../packages/database/src";

export type Client = {
  slug: string;
  endpoints: {
    DEVELOPMENT: ClientEndpoint;
    PRODUCTION: ClientEndpoint;
  };
};

export type ClientEndpoint =
  | {
      state: "unconfigured";
      environment: {
        id: string;
        apiKey: string;
        type: RuntimeEnvironmentType;
      };
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
      environment: {
        id: string;
        apiKey: string;
        type: RuntimeEnvironmentType;
      };
    };

export class EnvironmentsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    slug: projectSlug,
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

    //get all the possible client slugs
    const clientSlugs = new Set<string>();
    for (const environment of filtered) {
      for (const endpoint of environment.endpoints) {
        clientSlugs.add(endpoint.slug);
      }
    }

    //build up list of clients for display, with endpoints by type
    const clients: Client[] = [];
    for (const slug of clientSlugs) {
      const developmentEnvironment = filtered.find(
        (environment) => environment.type === "DEVELOPMENT"
      );
      if (!developmentEnvironment) {
        throw new Error(
          "Development environment not found, this should not happen"
        );
      }

      const productionEnvironment = filtered.find(
        (environment) => environment.type === "PRODUCTION"
      );
      if (!productionEnvironment) {
        throw new Error(
          "Production environment not found, this should not happen"
        );
      }

      const client: Client = {
        slug,
        endpoints: {
          DEVELOPMENT: {
            state: "unconfigured",
            environment: developmentEnvironment,
          },
          PRODUCTION: {
            state: "unconfigured",
            environment: productionEnvironment,
          },
        },
      };

      const devEndpoint = developmentEnvironment.endpoints.find(
        (endpoint) => endpoint.slug === slug
      );
      if (devEndpoint) {
        client.endpoints.DEVELOPMENT = endpointClient(
          devEndpoint,
          developmentEnvironment
        );
      }

      const prodEndpoint = productionEnvironment.endpoints.find(
        (endpoint) => endpoint.slug === slug
      );
      if (prodEndpoint) {
        client.endpoints.PRODUCTION = endpointClient(
          prodEndpoint,
          productionEnvironment
        );
      }

      clients.push(client);
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

function endpointClient(
  endpoint: Pick<Endpoint, "id" | "slug" | "url" | "indexingHookIdentifier"> & {
    indexings: Pick<EndpointIndex, "source" | "updatedAt" | "stats">[];
  },
  environment: Pick<RuntimeEnvironment, "id" | "apiKey" | "type">
): ClientEndpoint {
  return {
    state: "configured" as const,
    id: endpoint.id,
    slug: endpoint.slug,
    url: endpoint.url,
    indexWebhookPath: `/api/v1/endpoints/${environment.id}/${endpoint.slug}/index/${endpoint.indexingHookIdentifier}`,
    latestIndex: endpoint.indexings[0]
      ? {
          source: endpoint.indexings[0].source,
          updatedAt: endpoint.indexings[0].updatedAt,
          stats: parseEndpointIndexStats(endpoint.indexings[0].stats),
        }
      : undefined,
    environment: environment,
  };
}
