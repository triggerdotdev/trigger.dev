import { User } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { env } from "~/env.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { apiAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
import { Api, apisList } from "~/services/externalApis/apis";
import { integrationCatalog } from "~/services/externalApis/integrationCatalog.server";
import { Integration, OAuthClientSchema } from "~/services/externalApis/types";
import { getSecretStore } from "~/services/secrets/secretStore.server";

export type IntegrationOrApi =
  | ({
      type: "integration";
    } & Integration)
  | ({ type: "api" } & Api & { voted: boolean });

export class IntegrationsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
  }) {
    const clients = await this.#prismaClient.apiConnectionClient.findMany({
      select: {
        id: true,
        title: true,
        slug: true,
        description: true,
        integrationAuthMethod: true,
        integrationIdentifier: true,
        clientType: true,
        scopes: true,
        customClientReference: {
          select: {
            key: true,
          },
        },
        createdAt: true,
        _count: {
          select: {
            connections: true,
            jobIntegrations: {
              where: {
                job: {
                  project: {
                    slug: projectSlug,
                  },
                  internal: false,
                },
              },
            },
          },
        },
      },
      where: {
        organization: {
          slug: organizationSlug,
          members: {
            some: {
              userId,
            },
          },
        },
      },
      orderBy: {
        title: "asc",
      },
    });

    const secretStore = getSecretStore(env.SECRET_STORE, {
      prismaClient: this.#prismaClient,
    });

    const enrichedClients = await Promise.all(
      clients.map(async (c) => {
        const { integration, authMethod } =
          apiAuthenticationRepository.getIntegrationAndAuthMethod(c);

        if (authMethod.type !== "oauth2") {
          throw new Error("Only OAuth2 clients are supported");
        }

        let clientId: String | undefined = undefined;
        if (c.customClientReference) {
          const clientConfig = await secretStore.getSecret(
            OAuthClientSchema,
            c.customClientReference.key
          );
          clientId = clientConfig?.id;
        }

        return {
          id: c.id,
          title: c.title,
          slug: c.slug,
          integrationIdentifier: c.integrationIdentifier,
          description: c.description,
          scopesCount: c.scopes.length,
          connectionsCount: c._count.connections,
          jobCount: c._count.jobIntegrations,
          createdAt: c.createdAt,
          customClientId: clientId,
          integration: {
            identifier: integration.identifier,
            name: integration.name,
          },
          authMethod: {
            type: authMethod.type,
            name: authMethod.name,
          },
        };
      })
    );

    //filter out the ones that have no connections
    const clientsWithConnections = enrichedClients.filter(
      (c) => c.connectionsCount > 0
    );

    const integrations = Object.values(
      integrationCatalog.getIntegrations()
    ).map((i) => ({ type: "integration" as const, ...i }));

    //get all apis, some don't have integrations yet.
    //get whether the user has voted for them or not
    const votes = await this.#prismaClient.apiIntegrationVote.findMany({
      select: {
        apiIdentifier: true,
      },
      where: {
        userId,
      },
    });

    const apis = apisList
      .filter((a) => !integrations.some((i) => i.identifier === a.identifier))
      .map((a) => ({
        type: "api" as const,
        ...a,
        voted: votes.some((v) => v.apiIdentifier === a.identifier),
      }));

    const options = [...integrations, ...apis].sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    return {
      clients: clientsWithConnections,
      options,
    };
  }
}
