import { type User } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";
import { env } from "~/env.server";
import { type Organization } from "~/models/organization.server";
import { HelpSchema, OAuthClientSchema } from "~/services/externalApis/types";
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
    const integration = await this.#prismaClient.integration.findFirst({
      select: {
        id: true,
        title: true,
        slug: true,
        authMethod: {
          select: {
            key: true,
            type: true,
            name: true,
            help: true,
          },
        },
        authSource: true,
        definition: {
          select: {
            id: true,
            name: true,
            packageName: true,
            icon: true,
          },
        },
        connectionType: true,
        customClientReference: {
          select: {
            key: true,
          },
        },
        createdAt: true,
        _count: {
          select: {
            jobIntegrations: {
              where: {
                job: {
                  organization: {
                    slug: organizationSlug,
                  },
                  internal: false,
                  deletedAt: null,
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
        slug: clientSlug,
      },
    });

    if (!integration) {
      return undefined;
    }

    const secretStore = getSecretStore(env.SECRET_STORE, {
      prismaClient: this.#prismaClient,
    });

    let clientId: String | undefined = undefined;
    if (integration.customClientReference) {
      const clientConfig = await secretStore.getSecret(
        OAuthClientSchema,
        integration.customClientReference.key
      );
      clientId = clientConfig?.id;
    }

    const help = integration.authMethod?.help
      ? HelpSchema.parse(integration.authMethod?.help)
      : undefined;

    return {
      id: integration.id,
      title: integration.title ?? integration.slug,
      slug: integration.slug,
      integrationIdentifier: integration.definition.id,
      jobCount: integration._count.jobIntegrations,
      createdAt: integration.createdAt,
      customClientId: clientId,
      type: integration.connectionType,
      integration: {
        identifier: integration.definition.id,
        name: integration.definition.name,
        packageName: integration.definition.packageName,
        icon: integration.definition.icon,
      },
      authMethod: {
        type:
          integration.authMethod?.type ??
          (integration.authSource === "RESOLVER" ? "resolver" : "local"),
        name:
          integration.authMethod?.name ??
          (integration.authSource === "RESOLVER" ? "Auth Resolver" : "Local Auth"),
      },
      help,
    };
  }
}
