import { CreateExternalConnectionBody } from "@trigger.dev/core";
import { PrismaClientOrTransaction, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { integrationAuthRepository } from "~/services/externalApis/integrationAuthRepository.server";

export class CreateExternalConnectionService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    accountIdentifier: string,
    clientSlug: string,
    environment: AuthenticatedEnvironment,
    payload: CreateExternalConnectionBody
  ) {
    const externalAccount = await this.#prismaClient.externalAccount.upsert({
      where: {
        environmentId_identifier: {
          environmentId: environment.id,
          identifier: accountIdentifier,
        },
      },
      create: {
        environmentId: environment.id,
        organizationId: environment.organizationId,
        identifier: accountIdentifier,
      },
      update: {},
    });

    const integration = await this.#prismaClient.integration.findUniqueOrThrow({
      where: {
        organizationId_slug: {
          organizationId: environment.organizationId,
          slug: clientSlug,
        },
      },
    });

    return await integrationAuthRepository.createConnectionFromToken({
      externalAccount: externalAccount,
      integration,
      token: payload,
    });
  }
}
