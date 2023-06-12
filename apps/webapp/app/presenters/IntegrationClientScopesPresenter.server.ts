import { User } from ".prisma/client";
import { PrismaClient, prisma } from "~/db.server";
import { env } from "~/env.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { apiAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
import {
  ConnectionMetadataSchema,
  OAuthClientSchema,
} from "~/services/externalApis/types";
import { getSecretStore } from "~/services/secrets/secretStore.server";

export class IntegrationClientScopesPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    organizationSlug,
    projectSlug,
    clientSlug,
  }: {
    userId: User["id"];
    organizationSlug: Organization["slug"];
    projectSlug: Project["slug"];
    clientSlug: string;
  }) {
    const client = await this.#prismaClient.apiConnectionClient.findFirst({
      select: {
        integrationIdentifier: true,
        integrationAuthMethod: true,
        scopes: true,
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
      throw new Error("Client not found");
    }

    const { integration, authMethod } =
      apiAuthenticationRepository.getIntegrationAndAuthMethod(client);

    return {
      scopes: client.scopes.map((s) => {
        const matchingScope = authMethod.scopes.find(
          (scope) => scope.name === s
        );

        return {
          name: s,
          description: matchingScope?.description,
        };
      }),
    };
  }
}
