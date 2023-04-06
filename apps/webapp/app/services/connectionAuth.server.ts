import type { APIConnection } from ".prisma/client";
import { ConnectionAuth } from "@trigger.dev/internal";
import { apiKeyConfigSchema } from "~/models/apiConnection.server";
import { logger } from "./logger";
import { nango } from "./pizzly.server";

export async function getConnectionAuth(
  connection: APIConnection
): Promise<ConnectionAuth | undefined> {
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
