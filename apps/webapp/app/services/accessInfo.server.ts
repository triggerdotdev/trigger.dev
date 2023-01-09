import type { APIConnection } from ".prisma/client";
import { apiKeyConfigSchema } from "~/models/apiConnection.server";
import { pizzly } from "./pizzly.server";

export type AccessInfo =
  | { type: "oauth2"; accessToken: string }
  | {
      type: "api_key";
      api_key: string;
      additionalFields?: Record<string, string>;
    };

export async function getAccessInfo(
  connection: APIConnection
): Promise<AccessInfo | undefined> {
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
      return {
        type: "oauth2",
        accessToken,
      };
    }
    case "API_KEY": {
      const parsed = apiKeyConfigSchema.safeParse(
        connection.authenticationConfig
      );

      if (!parsed.success) {
        return undefined;
      }

      return { type: "api_key", ...parsed.data };
    }
    default: {
      throw new Error("Unsupported authentication method");
    }
  }
}
