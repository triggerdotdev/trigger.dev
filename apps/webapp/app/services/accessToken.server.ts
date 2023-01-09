import type { APIConnection } from ".prisma/client";
import { apiKeyConfigSchema } from "~/models/apiConnection.server";
import { pizzly } from "./pizzly.server";

export async function getAccessToken(
  connection: APIConnection
): Promise<string | null | undefined> {
  switch (connection.authenticationMethod) {
    case "OAUTH": {
      const accessToken = await pizzly.accessToken(
        connection.apiIdentifier,
        connection.id
      );
      if (accessToken == null) {
        return undefined;
      }
      //todo if it's an OAuth1 API then this will fail, as Pizzly returns an object
      return accessToken as string;
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
