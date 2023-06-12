import { User } from ".prisma/client";
import { PrismaClient, prisma } from "~/db.server";
import { env } from "~/env.server";
import { Organization } from "~/models/organization.server";
import { apiAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
import { OAuthClientSchema } from "~/services/externalApis/types";
import { getSecretStore } from "~/services/secrets/secretStore.server";

export class IntegrationClientPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    organizationSlug,
    clientSlug,
  }: {
    userId: User["id"];
    organizationSlug: Organization["slug"];
    clientSlug: string;
  }) {
    const client = await this.#prismaClient.apiConnectionClient.findFirst({
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
        jobIntegrations: {
          select: {
            version: {
              select: {
                version: true,
              },
            },
            job: {
              select: {
                id: true,
                title: true,
                slug: true,
              },
            },
          },
          where: {
            job: {
              internal: false,
            },
          },
        },
        _count: {
          select: {
            connections: true,
            jobIntegrations: true,
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
        slug: clientSlug,
      },
    });

    if (!client) {
      return undefined;
    }

    const secretStore = getSecretStore(env.SECRET_STORE, {
      prismaClient: this.#prismaClient,
    });

    const { integration, authMethod } =
      apiAuthenticationRepository.getIntegrationAndAuthMethod(client);

    let clientId: String | undefined = undefined;
    if (client.customClientReference) {
      const clientConfig = await secretStore.getSecret(
        OAuthClientSchema,
        client.customClientReference.key
      );
      clientId = clientConfig?.id;
    }

    return {
      id: client.id,
      title: client.title,
      slug: client.slug,
      integrationIdentifier: client.integrationIdentifier,
      description: client.description,
      scopesCount: client.scopes.length,
      connectionsCount: client._count.connections,
      jobCount: client._count.jobIntegrations,
      createdAt: client.createdAt,
      customClientId: clientId,
      integration: {
        identifier: integration.identifier,
        name: integration.name,
      },
      authMethod: {
        type: authMethod.type,
        name: authMethod.name,
      },
      jobs: client.jobIntegrations.map(
        (jobIntegration) => jobIntegration.job.id
      ),
    };
  }
}
