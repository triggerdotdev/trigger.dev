import { type User } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";
import { type Organization } from "~/models/organization.server";
import { ConnectionMetadataSchema } from "~/services/externalApis/types";

export class IntegrationClientConnectionsPresenter {
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
    const connections = await this.#prismaClient.integrationConnection.findMany({
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
        integration: {
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
        metadata: c.metadata != null ? ConnectionMetadataSchema.parse(c.metadata) : null,
        type: c.connectionType,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        runCount: c._count.runConnections,
      })),
    };
  }
}
