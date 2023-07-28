import type { Integration, RunConnection } from "@trigger.dev/database";
import type { ConnectionAuth } from "@trigger.dev/core";
import type { ConnectionWithSecretReference } from "~/services/externalApis/integrationAuthRepository.server";
import { integrationAuthRepository } from "~/services/externalApis/integrationAuthRepository.server";

export type ResolvableRunConnection = RunConnection & {
  integration: Integration;
  connection: ConnectionWithSecretReference | null;
};

export async function resolveRunConnections(
  connections: Array<ResolvableRunConnection>
): Promise<{ auth: Record<string, ConnectionAuth>; success: boolean }> {
  let allResolved = true;

  const result: Record<string, ConnectionAuth> = {};

  for (const connection of connections) {
    if (connection.integration.authSource === "LOCAL") {
      continue;
    }

    const auth = await resolveRunConnection(connection);

    if (!auth) {
      allResolved = false;
      continue;
    }

    result[connection.key] = auth;
  }

  return { auth: result, success: allResolved };
}

export async function resolveRunConnection(
  connection: ResolvableRunConnection
): Promise<ConnectionAuth | undefined> {
  if (!connection.connection) {
    return;
  }

  const response = await integrationAuthRepository.getCredentials(
    connection.connection
  );

  if (!response) {
    return;
  }

  return {
    type: "oauth2",
    scopes: response.scopes,
    accessToken: response.accessToken,
  };
}

export async function resolveApiConnection(
  connection?: ConnectionWithSecretReference
): Promise<ConnectionAuth | undefined> {
  if (!connection) {
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
