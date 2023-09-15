import { ExternalAccount, Integration, TriggerSource } from "@trigger.dev/database";
import { ConnectionAuth } from "@trigger.dev/core";
import { PrismaClientOrTransaction } from "~/db.server";
import { integrationAuthRepository } from "~/services/externalApis/integrationAuthRepository.server";
import { logger } from "~/services/logger.server";

type ResolvableTriggerSource = TriggerSource & {
  integration: Integration;
  externalAccount: ExternalAccount | null;
};

export async function resolveSourceConnection(
  tx: PrismaClientOrTransaction,
  source: ResolvableTriggerSource
): Promise<ConnectionAuth | undefined> {
  if (source.integration.authSource !== "HOSTED") return;

  const connection = await getConnection(tx, source);

  if (!connection) {
    logger.error(
      `Integration connection not found for source ${source.id}, integration ${source.integration.id}`
    );
    return;
  }

  const response = await integrationAuthRepository.getCredentials(connection);

  if (!response) {
    return;
  }

  return {
    type: "oauth2",
    scopes: response.scopes,
    accessToken: response.accessToken,
  };
}

function getConnection(tx: PrismaClientOrTransaction, source: ResolvableTriggerSource) {
  if (source.externalAccount) {
    return tx.integrationConnection.findFirst({
      where: {
        integrationId: source.integration.id,
        externalAccountId: source.externalAccount.id,
      },
      include: {
        dataReference: true,
      },
    });
  }

  return tx.integrationConnection.findFirst({
    where: {
      integrationId: source.integration.id,
    },
    include: {
      dataReference: true,
    },
  });
}
