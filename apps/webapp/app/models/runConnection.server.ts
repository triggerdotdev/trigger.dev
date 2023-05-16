import type { RunConnection } from ".prisma/client";
import type { ConnectionAuth } from "@trigger.dev/internal";
import type { ApiConnectionWithSecretReference } from "~/services/externalApis/apiAuthenticationRepository.server";
import { apiConnectionRepository } from "~/services/externalApis/apiAuthenticationRepository.server";

export type RunConnectionWithApiConnection = RunConnection & {
  apiConnection: ApiConnectionWithSecretReference | null;
};

export async function resolveRunConnections(
  connections: Array<RunConnectionWithApiConnection>
): Promise<Record<string, ConnectionAuth>> {
  const result: Record<string, ConnectionAuth> = {};

  for (const connection of connections) {
    const auth = await resolveRunConnection(connection);

    if (!auth) {
      continue;
    }

    result[connection.key] = auth;
  }

  return result;
}

export async function resolveRunConnection(
  connection: RunConnectionWithApiConnection
): Promise<ConnectionAuth | undefined> {
  if (!connection.apiConnection) {
    return;
  }

  const response = await apiConnectionRepository.getCredentials(
    connection.apiConnection
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
  connection?: ApiConnectionWithSecretReference
): Promise<ConnectionAuth | undefined> {
  if (!connection) {
    return;
  }

  const response = await apiConnectionRepository.getCredentials(connection);

  if (!response) {
    return;
  }

  return {
    type: "oauth2",
    scopes: response.scopes,
    accessToken: response.accessToken,
  };
}
