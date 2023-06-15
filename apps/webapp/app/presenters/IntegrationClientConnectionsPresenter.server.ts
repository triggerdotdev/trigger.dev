import { User } from "@trigger.dev/database";
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

export class IntegrationClientConnectionsPresenter {
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
    const connections = await this.#prismaClient.apiConnection.findMany({
      select: {
        id: true,
        expiresAt: true,
        metadata: true,
        connectionType: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            runConnections: true,
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
        client: {
          slug: clientSlug,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return {
      connections: connections.map((c) => ({
        id: c.id,
        expiresAt: c.expiresAt,
        metadata:
          c.metadata != null
            ? ConnectionMetadataSchema.parse(c.metadata)
            : null,
        type: c.connectionType,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        runCount: c._count.runConnections,
      })),
    };
  }
}
