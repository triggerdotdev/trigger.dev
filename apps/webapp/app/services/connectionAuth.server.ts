import type { APIConnection, JobConnection } from ".prisma/client";
import { ConnectionAuth } from "@trigger.dev/internal";
import { apiKeyConfigSchema } from "~/models/apiConnection.server";
import { logger } from "./logger";
import { nango } from "./pizzly.server";

export async function getConnectionAuth(
  connection?: APIConnection | null
): Promise<ConnectionAuth | undefined> {
  if (!connection) {
    return;
  }

  switch (connection.authenticationMethod) {
    case "OAUTH": {
      try {
        logger.info("Getting access token", {
          providerConfigKey: connection.apiIdentifier,
          connectionId: connection.id,
        });

        const accessToken = await getNangoToken(
          connection.apiIdentifier,
          connection.id
        );

        if (!accessToken) {
          return undefined;
        }
        //todo if it's an OAuth1 API then this will fail, as Pizzly returns an object
        return {
          type: "oauth",
          accessToken,
          connectionId: connection.id,
        };
      } catch (e) {
        console.error(e);
        return undefined;
      }
    }
    case "API_KEY": {
      const parsed = apiKeyConfigSchema.safeParse(
        connection.authenticationConfig
      );

      if (!parsed.success) {
        return undefined;
      }

      return {
        type: "apiKey",
        apiKey: parsed.data.api_key,
        additionalFields: parsed.data.additionalFields,
        connectionId: connection.id,
      };
    }
    default: {
      throw new Error("Unsupported authentication method");
    }
  }
}

async function getNangoToken(
  providerConfigKey: string,
  connectionId: string
): Promise<string | undefined> {
  try {
    return await nango.getToken(providerConfigKey, connectionId);
  } catch (e) {
    // TODO: remove this once we have a better way to handle this
    return process.env.TEST_GITHUB_TOKEN;
  }
}

export async function getConnectionAuths(
  connections: Array<JobConnection & { apiConnection?: APIConnection | null }>
): Promise<Record<string, ConnectionAuth>> {
  return await connections.reduce(
    async (accP: Promise<Record<string, ConnectionAuth>>, connection) => {
      const acc = await accP;

      if (connection.usesLocalAuth) {
        return acc;
      }

      const connectionAuth = await getConnectionAuth(connection.apiConnection!);

      if (connectionAuth) {
        acc[connection.key] = connectionAuth;
      }

      return acc;
    },
    Promise.resolve({})
  );
}
