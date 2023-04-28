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
    if (!connection.apiConnection) {
      continue;
    }

    const response = await apiConnectionRepository.getCredentials(
      connection.apiConnection
    );

    if (!response) {
      continue;
    }

    if (result[connection.key]) {
      throw new Error(
        `Duplicate connection key ${connection.key} in job instance ${connection.jobInstanceId}`
      );
    }

    result[connection.key] = {
      type: "oauth2",
      scopes: response.scopes,
      accessToken: response.accessToken,
    };
  }

  return result;
}
