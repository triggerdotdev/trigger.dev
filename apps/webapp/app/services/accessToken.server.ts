import type { APIConnection } from ".prisma/client";
import { apiKeyConfigSchema } from "~/models/apiConnection.server";
import { pizzly } from "./pizzly.server";

export async function getAccessToken(
  connection: APIConnection
): Promise<string | null | undefined> {
  switch (connection.authenticationMethod) {
    case "OAUTH": {
      return await pizzly.accessToken(connection.apiIdentifier, connection.id);
    }
    case "API_KEY": {
      const parsed = apiKeyConfigSchema.safeParse(
        connection.authenticationConfig
      );

      if (!parsed.success) {
        return undefined;
      }

      return parsed.data.api_key;
    }
    default: {
      throw new Error("Unsupported authentication method");
    }
  }
}
