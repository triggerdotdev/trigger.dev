import { type User } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";
import { type Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";

import { type Scope } from "~/services/externalApis/types";

export class IntegrationClientScopesPresenter {
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
        authMethod: true,
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

    if (!integration) {
      throw new Error("Client not found");
    }

    const authMethodScopes = (integration.authMethod?.scopes ?? []) as Scope[];

    return {
      scopes: integration.scopes.map((s) => {
        const matchingScope = authMethodScopes.find((scope) => scope.name === s);

        return {
          name: s,
          description: matchingScope?.description,
        };
      }),
    };
  }
}
