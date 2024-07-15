import { type PrismaClient, prisma } from "~/db.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import type {
  Endpoint,
  EndpointIndex,
  EndpointIndexStatus,
  RuntimeEnvironment,
  RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { type EndpointIndexError , EndpointIndexErrorSchema , type IndexEndpointStats , parseEndpointIndexStats } from '@trigger.dev/core/schemas';
import { sortEnvironments } from "~/utils/environmentSort";

export type Client = {
  slug: string;
  endpoints: {
    DEVELOPMENT: ClientEndpoint;
    PRODUCTION: ClientEndpoint;
    STAGING?: ClientEndpoint;
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
      url: string | null;
      indexWebhookPath: string;
      latestIndex?: {
        status: EndpointIndexStatus;
        source: string;
        updatedAt: Date;
        stats?: IndexEndpointStats;
        error?: EndpointIndexError;
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
    projectSlug,
    baseUrl,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    baseUrl: string;
  }) {
    const environments = await this.#prismaClient.runtimeEnvironment.findMany({
      select: {
        id: true,
        apiKey: true,
        pkApiKey: true,
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
                status: true,
                source: true,
                updatedAt: true,
                stats: true,
                error: true,
              },
              take: 1,
              orderBy: {
                updatedAt: "desc",
              },
            },
          },
          where: {
            url: {
              not: null,
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
        throw new Error("Development environment not found, this should not happen");
      }

      const stagingEnvironment = filtered.find((environment) => environment.type === "STAGING");

      const productionEnvironment = filtered.find(
        (environment) => environment.type === "PRODUCTION"
      );
      if (!productionEnvironment) {
        throw new Error("Production environment not found, this should not happen");
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
          STAGING: stagingEnvironment
            ? { state: "unconfigured", environment: stagingEnvironment }
            : undefined,
        },
      };

      const devEndpoint = developmentEnvironment.endpoints.find(
        (endpoint) => endpoint.slug === slug
      );
      if (devEndpoint) {
        client.endpoints.DEVELOPMENT = endpointClient(devEndpoint, developmentEnvironment, baseUrl);
      }

      if (stagingEnvironment) {
        const stagingEndpoint = stagingEnvironment.endpoints.find(
          (endpoint) => endpoint.slug === slug
        );

        if (stagingEndpoint) {
          client.endpoints.STAGING = endpointClient(stagingEndpoint, stagingEnvironment, baseUrl);
        }
      }

      const prodEndpoint = productionEnvironment.endpoints.find(
        (endpoint) => endpoint.slug === slug
      );
      if (prodEndpoint) {
        client.endpoints.PRODUCTION = endpointClient(prodEndpoint, productionEnvironment, baseUrl);
      }

      clients.push(client);
    }

    return {
      environments: sortEnvironments(
        filtered.map((environment) => ({
          id: environment.id,
          apiKey: environment.apiKey,
          pkApiKey: environment.pkApiKey,
          type: environment.type,
          slug: environment.slug,
        }))
      ),
      clients,
    };
  }
}

function endpointClient(
  endpoint: Pick<Endpoint, "id" | "slug" | "url" | "indexingHookIdentifier"> & {
    indexings: Pick<EndpointIndex, "status" | "source" | "updatedAt" | "stats" | "error">[];
  },
  environment: Pick<RuntimeEnvironment, "id" | "apiKey" | "type">,
  baseUrl: string
): ClientEndpoint {
  return {
    state: "configured" as const,
    id: endpoint.id,
    slug: endpoint.slug,
    url: endpoint.url,
    indexWebhookPath: `${baseUrl}/api/v1/endpoints/${environment.id}/${endpoint.slug}/index/${endpoint.indexingHookIdentifier}`,
    latestIndex: endpoint.indexings[0]
      ? {
          status: endpoint.indexings[0].status,
          source: endpoint.indexings[0].source,
          updatedAt: endpoint.indexings[0].updatedAt,
          stats: parseEndpointIndexStats(endpoint.indexings[0].stats),
          error: endpoint.indexings[0].error
            ? EndpointIndexErrorSchema.parse(endpoint.indexings[0].error)
            : undefined,
        }
      : undefined,
    environment: environment,
  };
}
