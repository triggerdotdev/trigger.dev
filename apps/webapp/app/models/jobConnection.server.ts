import type { JobConnection } from ".prisma/client";
import type { ConnectionAuth } from "@trigger.dev/internal";
import type { ApiConnectionWithSecretReference } from "~/services/externalApis/apiAuthenticationRepository.server";
import { apiConnectionRepository } from "~/services/externalApis/apiAuthenticationRepository.server";

export type JobConnectionWithApiConnection = JobConnection & {
  apiConnection: ApiConnectionWithSecretReference | null;
};

export async function resolveJobConnections(
  connections: Array<JobConnectionWithApiConnection>
): Promise<Record<string, ConnectionAuth>> {
  const result: Record<string, ConnectionAuth> = {};

  for (const connection of connections) {
    const auth = await resolveJobConnection(connection);

    if (!auth) {
      continue;
    }

    result[connection.key] = auth;
  }

  return result;
}

export async function resolveJobConnection(
  connection: JobConnectionWithApiConnection
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
